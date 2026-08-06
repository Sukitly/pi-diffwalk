import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import type {
  ChangedLineRef,
  ReviewComment,
  ReviewCommentId,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewSubmissionMode,
  ReviewThreadBatch,
  ReviewThreadBatchId,
  SnapshotId,
} from "./types.ts";

export const REVIEW_RESPONSES_TOOL_NAME = "submit_diffwalk_responses";
export const REVIEW_RESPONSES_TOOL_DESCRIPTION =
  "Submit one structured Agent response for every comment in the pending DiffWalk batch, then open the anchored thread UI";
export const REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET =
  "Return complete structured responses for a pending DiffWalk comment batch";

export const ReviewResponseCandidateSchema = Type.Object(
  {
    batchId: Type.String({
      description: "Identifier of the pending DiffWalk comment batch",
    }),
    responses: Type.Array(
      Type.Object(
        {
          commentId: Type.String({
            description:
              "Comment identifier from the pending batch, such as C1",
          }),
          body: Type.String({
            description:
              "Direct answer to this comment, grounded in the reviewed code",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description: "Exactly one response for every comment in the batch",
        minItems: 1,
      },
    ),
  },
  { additionalProperties: false },
);

export type ReviewResponseCandidate = Static<
  typeof ReviewResponseCandidateSchema
>;

export type ReviewThreadErrorCode =
  | "empty-batch"
  | "snapshot-mismatch"
  | "batch-mismatch"
  | "already-answered"
  | "blank-response"
  | "duplicate-response"
  | "unknown-comment"
  | "missing-response"
  | "response-required";

export class ReviewThreadError extends Error {
  readonly code: ReviewThreadErrorCode;

  constructor(code: ReviewThreadErrorCode, message: string) {
    super(message);
    this.name = "ReviewThreadError";
    this.code = code;
  }
}

export interface CreateReviewThreadBatchInput {
  readonly seriesId: ReviewSeriesId;
  readonly roundId: ReviewRoundId;
  readonly snapshotId: SnapshotId;
  readonly submissionMode: ReviewSubmissionMode;
  readonly comments: readonly ReviewComment[];
}

export function createReviewThreadBatch(
  input: CreateReviewThreadBatchInput,
): ReviewThreadBatch {
  if (input.comments.length === 0) {
    throw new ReviewThreadError(
      "empty-batch",
      "A DiffWalk comment batch requires at least one comment.",
    );
  }
  for (const comment of input.comments) {
    if (comment.snapshotId !== input.snapshotId) {
      throw new ReviewThreadError(
        "snapshot-mismatch",
        `Comment on ${comment.filePath} references snapshot ${comment.snapshotId}, not ${input.snapshotId}.`,
      );
    }
  }

  return {
    id: hashAs<ReviewThreadBatchId>("review-thread-batch", {
      roundId: input.roundId,
    }),
    seriesId: input.seriesId,
    roundId: input.roundId,
    snapshotId: input.snapshotId,
    submissionMode: input.submissionMode,
    threads: input.comments.map((comment, index) => ({
      id: `C${index + 1}` as ReviewCommentId,
      comment: copyComment(comment),
      resolved: false,
    })),
  };
}

export function attachReviewThreadResponses(
  batch: ReviewThreadBatch,
  candidate: ReviewResponseCandidate,
): ReviewThreadBatch {
  if (candidate.batchId !== batch.id) {
    throw new ReviewThreadError(
      "batch-mismatch",
      `Response batch ${candidate.batchId} does not match pending DiffWalk batch ${batch.id}.`,
    );
  }
  if (batch.threads.some((thread) => thread.response !== undefined)) {
    throw new ReviewThreadError(
      "already-answered",
      `DiffWalk batch ${batch.id} already has Agent responses.`,
    );
  }

  const knownIds = new Set(batch.threads.map((thread) => thread.id));
  const responses = new Map<ReviewCommentId, string>();
  for (const response of candidate.responses) {
    if (response.body.trim().length === 0) {
      throw new ReviewThreadError(
        "blank-response",
        `Response for comment ${response.commentId} must not be blank.`,
      );
    }
    if (!knownIds.has(response.commentId as ReviewCommentId)) {
      throw new ReviewThreadError(
        "unknown-comment",
        `Response references unknown comment ${response.commentId} in batch ${batch.id}.`,
      );
    }
    const commentId = response.commentId as ReviewCommentId;
    if (responses.has(commentId)) {
      throw new ReviewThreadError(
        "duplicate-response",
        `Comment ${commentId} has more than one response.`,
      );
    }
    responses.set(commentId, response.body);
  }

  const missing = batch.threads
    .filter((thread) => !responses.has(thread.id))
    .map((thread) => thread.id);
  if (missing.length > 0) {
    throw new ReviewThreadError(
      "missing-response",
      `Batch ${batch.id} is missing responses for: ${missing.join(", ")}.`,
    );
  }

  return {
    ...copyBatch(batch),
    threads: batch.threads.map((thread) => ({
      ...copyThread(thread),
      response: { body: responses.get(thread.id) ?? "" },
    })),
  };
}

export function setReviewThreadResolved(
  batch: ReviewThreadBatch,
  commentId: ReviewCommentId,
  resolved: boolean,
): ReviewThreadBatch {
  const thread = batch.threads.find((candidate) => candidate.id === commentId);
  if (thread === undefined) {
    throw new ReviewThreadError(
      "unknown-comment",
      `Batch ${batch.id} has no comment ${commentId}.`,
    );
  }
  if (thread.response === undefined) {
    throw new ReviewThreadError(
      "response-required",
      `Comment ${commentId} cannot be resolved before the Agent responds.`,
    );
  }
  if (thread.resolved === resolved) return batch;
  return {
    ...copyBatch(batch),
    threads: batch.threads.map((candidate) =>
      candidate.id === commentId
        ? { ...copyThread(candidate), resolved }
        : copyThread(candidate),
    ),
  };
}

export function resolvedCommentLines(
  batch: ReviewThreadBatch,
): readonly ChangedLineRef[] {
  return batch.threads
    .filter((thread) => thread.resolved)
    .map((thread) => ({
      fileChangeId: thread.comment.fileChangeId,
      side: thread.comment.side,
      line: thread.comment.line,
    }));
}

export function isReviewThreadBatchAnswered(batch: ReviewThreadBatch): boolean {
  return batch.threads.every((thread) => thread.response !== undefined);
}

export function copyReviewThreadBatch(
  batch: ReviewThreadBatch,
): ReviewThreadBatch {
  return copyBatch(batch);
}

function copyBatch(batch: ReviewThreadBatch): ReviewThreadBatch {
  return {
    ...batch,
    threads: batch.threads.map(copyThread),
  };
}

function copyThread(
  thread: ReviewThreadBatch["threads"][number],
): ReviewThreadBatch["threads"][number] {
  return {
    ...thread,
    comment: copyComment(thread.comment),
    ...(thread.response === undefined
      ? {}
      : { response: { ...thread.response } }),
  };
}

function copyComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    nearbyContext: comment.nearbyContext.map((line) => ({ ...line })),
  };
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
