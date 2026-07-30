import { createHash } from "node:crypto";
import {
  assertReviewDeltaMatchesSnapshot,
  isNeedsReviewReasonSkippable,
  listSnapshotHunks,
  ReviewDeltaError,
} from "./review-delta.ts";
import type {
  DiffHunk,
  HunkId,
  HunkReviewRequirement,
  ReviewDelta,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewRouteSkip,
  ReviewSnapshot,
  ReviewUnit,
  ReviewUnitId,
} from "./types.ts";

export type ReviewRouteValidationIssueCode =
  | "snapshot-mismatch"
  | "empty-field"
  | "empty-unit"
  | "unknown-hunk"
  | "carried-forward-reference"
  | "duplicate-hunk"
  | "missing-hunk"
  | "empty-skip-reason"
  | "unresolved-comment-skip"
  | "missing-review-unit";

export interface ReviewRouteValidationIssue {
  readonly code: ReviewRouteValidationIssueCode;
  readonly message: string;
}

export class ReviewRouteValidationError extends Error {
  readonly issues: readonly ReviewRouteValidationIssue[];

  constructor(issues: readonly ReviewRouteValidationIssue[]) {
    super(
      `Invalid review route:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}`,
    );
    this.name = "ReviewRouteValidationError";
    this.issues = [...issues];
  }
}

interface ValidatedHunkReference {
  readonly hunkId: HunkId;
  readonly requirement: HunkReviewRequirement;
}

export function validateReviewRoute(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  candidate: ReviewRouteCandidate,
): ReviewRoute {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  const hunks = listSnapshotHunks(snapshot);
  const hunksById = new Map<string, DiffHunk>(
    hunks.map((hunk) => [hunk.id, hunk]),
  );
  const requirementsById = new Map(
    delta.hunks.map((requirement) => [requirement.hunkId, requirement]),
  );
  const issues: ReviewRouteValidationIssue[] = [];

  if (candidate.snapshotId !== snapshot.id) {
    issues.push({
      code: "snapshot-mismatch",
      message: `Route references snapshot ${candidate.snapshotId}, not ${snapshot.id}.`,
    });
  }

  const referencedHunkIds = new Set<string>();
  const units: ReviewUnit[] = candidate.units.map((unit, unitIndex) => {
    const unitNumber = unitIndex + 1;
    validateNonBlank(unit.title, `Review unit ${unitNumber} title`, issues);
    validateNonBlank(unit.whyHere, `Review unit ${unitNumber} whyHere`, issues);
    validateNonBlank(unit.context, `Review unit ${unitNumber} context`, issues);
    validateNonBlank(
      unit.changeSummary,
      `Review unit ${unitNumber} changeSummary`,
      issues,
    );
    if (unit.reviewFocus.length === 0) {
      issues.push({
        code: "empty-field",
        message: `Review unit ${unitNumber} requires at least one review focus question.`,
      });
    }
    for (const [focusIndex, focus] of unit.reviewFocus.entries()) {
      validateNonBlank(
        focus,
        `Review unit ${unitNumber} reviewFocus item ${focusIndex + 1}`,
        issues,
      );
    }
    if (unit.hunkIds.length === 0) {
      issues.push({
        code: "empty-unit",
        message: `Review unit ${unitNumber} must reference at least one hunk.`,
      });
    }

    const hunkIds = unit.hunkIds.flatMap((candidateHunkId) => {
      const reference = validateCandidateHunkReference(
        candidateHunkId,
        `review unit ${unitNumber}`,
        hunksById,
        requirementsById,
        referencedHunkIds,
        issues,
      );
      return reference === undefined ? [] : [reference.hunkId];
    });

    return {
      id: createReviewUnitId(snapshot.id, unitIndex, hunkIds),
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus: [...unit.reviewFocus],
      hunkIds,
    };
  });

  const skippedHunks: ReviewRouteSkip[] = candidate.skippedHunks.flatMap(
    (skipped, skipIndex) => {
      const skipNumber = skipIndex + 1;
      if (skipped.reason.trim().length === 0) {
        issues.push({
          code: "empty-skip-reason",
          message: `Skipped hunk ${skipped.hunkId} requires a non-empty reason.`,
        });
      }
      const reference = validateCandidateHunkReference(
        skipped.hunkId,
        `skip ${skipNumber}`,
        hunksById,
        requirementsById,
        referencedHunkIds,
        issues,
      );
      if (
        reference?.requirement.type === "needs-review" &&
        !isNeedsReviewReasonSkippable(reference.requirement.reason)
      ) {
        issues.push({
          code: "unresolved-comment-skip",
          message: `Hunk ${reference.hunkId} has an unresolved comment and cannot be skipped.`,
        });
      }
      return reference === undefined
        ? []
        : [{ hunkId: reference.hunkId, reason: skipped.reason }];
    },
  );

  for (const requirement of delta.hunks) {
    if (
      requirement.type === "needs-review" &&
      !referencedHunkIds.has(requirement.hunkId)
    ) {
      issues.push({
        code: "missing-hunk",
        message: `Review route does not cover required hunk ${requirement.hunkId}.`,
      });
    }
  }
  if (
    delta.hunks.some((requirement) => requirement.type === "needs-review") &&
    !candidate.units.some((unit) => unit.hunkIds.length > 0)
  ) {
    issues.push({
      code: "missing-review-unit",
      message:
        "A route with hunks requiring review must contain at least one non-empty review unit.",
    });
  }

  throwIfIssues(issues);
  return {
    snapshotId: snapshot.id,
    units,
    skippedHunks,
  } as unknown as ReviewRoute;
}

function validateCandidateHunkReference(
  candidateHunkId: string,
  location: string,
  hunksById: ReadonlyMap<string, DiffHunk>,
  requirementsById: ReadonlyMap<HunkId, HunkReviewRequirement>,
  referencedHunkIds: Set<string>,
  issues: ReviewRouteValidationIssue[],
): ValidatedHunkReference | undefined {
  const hunk = hunksById.get(candidateHunkId);
  if (hunk === undefined) {
    issues.push({
      code: "unknown-hunk",
      message: `Route ${location} references unknown hunk ${candidateHunkId}.`,
    });
    return undefined;
  }
  const requirement = requirementsById.get(hunk.id);
  if (requirement === undefined) {
    throw new ReviewDeltaError(
      `Validated review delta has no requirement for snapshot hunk ${hunk.id}.`,
    );
  }
  if (requirement.type === "carried-forward") {
    issues.push({
      code: "carried-forward-reference",
      message: `Route ${location} references carried-forward hunk ${candidateHunkId}; carried-forward hunks are available outside the planned route.`,
    });
    return undefined;
  }
  if (referencedHunkIds.has(candidateHunkId)) {
    issues.push({
      code: "duplicate-hunk",
      message: `Hunk ${candidateHunkId} is referenced more than once; duplicate appears in ${location}.`,
    });
    return undefined;
  }
  referencedHunkIds.add(candidateHunkId);
  return { hunkId: hunk.id, requirement };
}

function validateNonBlank(
  value: string,
  label: string,
  issues: ReviewRouteValidationIssue[],
): void {
  if (value.trim().length === 0) {
    issues.push({
      code: "empty-field",
      message: `${label} must not be blank.`,
    });
  }
}

function throwIfIssues(issues: readonly ReviewRouteValidationIssue[]): void {
  if (issues.length > 0) throw new ReviewRouteValidationError(issues);
}

function createReviewUnitId(
  snapshotId: string,
  unitIndex: number,
  hunkIds: readonly HunkId[],
): ReviewUnitId {
  const hash = createHash("sha256");
  hash.update("review-unit");
  hash.update("\0");
  hash.update(
    JSON.stringify({
      snapshotId,
      sequence: unitIndex + 1,
      hunkIds,
    }),
  );
  return `review-unit:${hash.digest("hex")}` as ReviewUnitId;
}
