import { createHash } from "node:crypto";
import {
  type ReviewCommentAnchor,
  type ReviewCommentInput,
  ReviewSession,
} from "./comments.ts";
import { computeReviewCoverage } from "./coverage.ts";
import { assertReviewDeltaMatchesSnapshot } from "./delta.ts";
import {
  appendReviewRound,
  createReviewRound,
  getNextReviewRoundIdentity,
} from "./series.ts";
import type {
  InProgressReview,
  InProgressReviewId,
  InProgressReviewLifecycle,
  RepositoryState,
  ReviewRoute,
  ReviewSeries,
  ReviewSubmissionMode,
  ReviewUnitId,
} from "./types.ts";

export type InProgressReviewErrorCode =
  | "version-conflict"
  | "invalid-lifecycle"
  | "invalid-timestamp"
  | "series-mismatch"
  | "route-snapshot-mismatch"
  | "route-already-attached"
  | "route-not-attached"
  | "unknown-review-unit"
  | "review-incomplete"
  | "repository-drifted";

export class InProgressReviewError extends Error {
  readonly code: InProgressReviewErrorCode;

  constructor(code: InProgressReviewErrorCode, message: string) {
    super(message);
    this.name = "InProgressReviewError";
    this.code = code;
  }
}

export interface CreateInProgressReviewInput {
  readonly series: ReviewSeries;
  readonly snapshot: InProgressReview["snapshot"];
  readonly delta: InProgressReview["delta"];
  readonly timestamp: string;
  readonly submissionMode?: ReviewSubmissionMode;
}

export interface ReviewMutation {
  readonly expectedVersion: number;
  readonly timestamp: string;
}

export interface ReviewSubmissionBlockers {
  readonly blockingLifecycle?: Exclude<InProgressReviewLifecycle, "ready">;
  readonly routeNotAttached: boolean;
  readonly pendingReviewUnitIds: readonly ReviewUnitId[];
  readonly repositoryDrifted: boolean;
}

export interface SubmitInProgressReviewResult {
  readonly review: InProgressReview;
  readonly series: ReviewSeries;
  readonly round: ReviewSeries["rounds"][number];
}

export function createInProgressReview(
  input: CreateInProgressReviewInput,
): InProgressReview {
  assertTimestamp(input.timestamp);
  assertReviewDeltaMatchesSnapshot(input.snapshot, input.delta);
  getNextReviewRoundIdentity(input.series, input.snapshot);
  return {
    id: hashAs<InProgressReviewId>("in-progress-review", {
      seriesId: input.series.id,
      snapshotId: input.snapshot.id,
    }),
    seriesId: input.series.id,
    snapshot: structuredClone(input.snapshot),
    delta: structuredClone(input.delta),
    unitProgress: [],
    comments: [],
    submissionMode: input.submissionMode ?? "discuss-first",
    lifecycle: "preparing-route",
    version: 1,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

export function attachReviewRoute(
  review: InProgressReview,
  route: ReviewRoute,
  mutation: ReviewMutation,
): InProgressReview {
  assertMutation(review, mutation);
  if (review.lifecycle !== "preparing-route") {
    throw new InProgressReviewError(
      review.route === undefined
        ? "invalid-lifecycle"
        : "route-already-attached",
      `Review ${review.id} cannot attach a route while lifecycle is ${review.lifecycle}.`,
    );
  }
  if (route.snapshotId !== review.snapshot.id) {
    throw new InProgressReviewError(
      "route-snapshot-mismatch",
      `Route snapshot ${route.snapshotId} does not match review snapshot ${review.snapshot.id}.`,
    );
  }
  return nextVersion(review, mutation.timestamp, {
    route,
    unitProgress: route.units.map((unit) => ({
      reviewUnitId: unit.id,
      disposition: "pending" as const,
    })),
    lifecycle: "ready",
  });
}

export function markReviewUnitReviewed(
  review: InProgressReview,
  reviewUnitId: ReviewUnitId,
  mutation: ReviewMutation,
): InProgressReview {
  assertReadyMutation(review, mutation);
  const progressIndex = review.unitProgress.findIndex(
    (progress) => progress.reviewUnitId === reviewUnitId,
  );
  if (progressIndex < 0) {
    throw new InProgressReviewError(
      "unknown-review-unit",
      `Review ${review.id} has no review unit ${reviewUnitId}.`,
    );
  }
  if (review.unitProgress[progressIndex]?.disposition === "reviewed") {
    return review;
  }
  return nextVersion(review, mutation.timestamp, {
    unitProgress: review.unitProgress.map((progress, index) =>
      index === progressIndex
        ? { ...progress, disposition: "reviewed" }
        : progress,
    ),
  });
}

export function upsertInProgressReviewComment(
  review: InProgressReview,
  input: ReviewCommentInput,
  mutation: ReviewMutation,
): InProgressReview {
  assertReadyMutation(review, mutation);
  const session = materializeReviewSession(review);
  session.upsertComment(input);
  return nextVersion(review, mutation.timestamp, {
    comments: session.getComments(),
  });
}

export function deleteInProgressReviewComment(
  review: InProgressReview,
  anchor: ReviewCommentAnchor,
  mutation: ReviewMutation,
): InProgressReview {
  assertReadyMutation(review, mutation);
  const session = materializeReviewSession(review);
  const result = session.deleteComment(anchor);
  if (!result.deleted) return review;
  return nextVersion(review, mutation.timestamp, {
    comments: session.getComments(),
  });
}

export function setInProgressReviewSubmissionMode(
  review: InProgressReview,
  submissionMode: ReviewSubmissionMode,
  mutation: ReviewMutation,
): InProgressReview {
  assertReadyMutation(review, mutation);
  if (review.submissionMode === submissionMode) return review;
  return nextVersion(review, mutation.timestamp, { submissionMode });
}

export function getReviewSubmissionBlockers(
  review: InProgressReview,
  currentRepositoryState: RepositoryState,
): ReviewSubmissionBlockers {
  return {
    blockingLifecycle:
      review.lifecycle === "ready" ? undefined : review.lifecycle,
    routeNotAttached: review.route === undefined,
    pendingReviewUnitIds: review.unitProgress
      .filter((progress) => progress.disposition === "pending")
      .map((progress) => progress.reviewUnitId),
    repositoryDrifted: !sameRepositoryState(
      review.snapshot.repositoryState,
      currentRepositoryState,
    ),
  };
}

export function submitInProgressReview(
  review: InProgressReview,
  series: ReviewSeries,
  currentRepositoryState: RepositoryState,
  mutation: ReviewMutation,
): SubmitInProgressReviewResult {
  assertMutation(review, mutation);
  const blockers = getReviewSubmissionBlockers(review, currentRepositoryState);
  if (blockers.blockingLifecycle !== undefined || blockers.routeNotAttached) {
    throw new InProgressReviewError(
      "invalid-lifecycle",
      `Review ${review.id} is not ready for submission.`,
    );
  }
  if (blockers.pendingReviewUnitIds.length > 0) {
    throw new InProgressReviewError(
      "review-incomplete",
      `Review ${review.id} has pending units: ${blockers.pendingReviewUnitIds.join(", ")}.`,
    );
  }
  if (blockers.repositoryDrifted) {
    throw new InProgressReviewError(
      "repository-drifted",
      `Repository state no longer matches review snapshot ${review.snapshot.id}.`,
    );
  }
  if (series.id !== review.seriesId) {
    throw new InProgressReviewError(
      "series-mismatch",
      `Review ${review.id} belongs to series ${review.seriesId}, not ${series.id}.`,
    );
  }
  const route = requireRoute(review);
  const roundIdentity = getNextReviewRoundIdentity(series, review.snapshot);
  const coverage = computeReviewCoverage(
    roundIdentity.id,
    review.snapshot,
    review.delta,
    {
      commentedLines: review.comments.map((comment) => ({
        fileChangeId: comment.fileChangeId,
        side: comment.side,
        line: comment.line,
      })),
      skippedSpans: route.skippedSpans,
    },
  );
  const round = createReviewRound(
    series,
    review.snapshot,
    review.delta,
    coverage,
  );
  return {
    review: nextVersion(review, mutation.timestamp, {
      lifecycle: "submitted",
    }),
    series: appendReviewRound(series, round),
    round,
  };
}

export function discardInProgressReview(
  review: InProgressReview,
  mutation: ReviewMutation,
): InProgressReview {
  assertMutation(review, mutation);
  if (review.lifecycle !== "preparing-route" && review.lifecycle !== "ready") {
    throw new InProgressReviewError(
      "invalid-lifecycle",
      `Review ${review.id} cannot be discarded while lifecycle is ${review.lifecycle}.`,
    );
  }
  return nextVersion(review, mutation.timestamp, {
    lifecycle: "discarded",
    comments: [],
  });
}

function materializeReviewSession(review: InProgressReview): ReviewSession {
  const session = new ReviewSession(review.snapshot, requireRoute(review));
  for (const comment of review.comments) {
    session.upsertComment({
      reviewUnitId: comment.reviewUnitId,
      fileChangeId: comment.fileChangeId,
      side: comment.side,
      line: comment.line,
      body: comment.body,
    });
  }
  return session;
}

function requireRoute(review: InProgressReview): ReviewRoute {
  if (review.route === undefined) {
    throw new InProgressReviewError(
      "route-not-attached",
      `Review ${review.id} has no validated route.`,
    );
  }
  return review.route;
}

function assertReadyMutation(
  review: InProgressReview,
  mutation: ReviewMutation,
): void {
  assertMutation(review, mutation);
  if (review.lifecycle !== "ready") {
    throw new InProgressReviewError(
      "invalid-lifecycle",
      `Review ${review.id} cannot be changed while lifecycle is ${review.lifecycle}.`,
    );
  }
  requireRoute(review);
}

function assertMutation(
  review: InProgressReview,
  mutation: ReviewMutation,
): void {
  assertTimestamp(mutation.timestamp);
  if (review.version !== mutation.expectedVersion) {
    throw new InProgressReviewError(
      "version-conflict",
      `Review ${review.id} has version ${review.version}, not expected version ${mutation.expectedVersion}.`,
    );
  }
}

function nextVersion(
  review: InProgressReview,
  timestamp: string,
  changes: Partial<InProgressReview>,
): InProgressReview {
  return structuredClone({
    ...review,
    ...changes,
    version: review.version + 1,
    updatedAt: timestamp,
  });
}

function sameRepositoryState(
  left: RepositoryState,
  right: RepositoryState,
): boolean {
  return (
    left.headOid === right.headOid &&
    left.stagedFingerprint === right.stagedFingerprint &&
    left.unstagedFingerprint === right.unstagedFingerprint &&
    left.untrackedFingerprint === right.untrackedFingerprint
  );
}

function assertTimestamp(timestamp: string): void {
  if (timestamp.trim().length === 0) {
    throw new InProgressReviewError(
      "invalid-timestamp",
      "Review mutation timestamp is required.",
    );
  }
}

function hashAs<Value extends string>(
  namespace: string,
  value: unknown,
): Value {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(JSON.stringify(value));
  return `${namespace}:${hash.digest("hex")}` as Value;
}
