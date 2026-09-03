import { type Static, Type } from "typebox";
import { hashAs } from "./ids.ts";
import type {
  ChangedLineRef,
  ReviewComment,
  ReviewCommentId,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewSubmissionMode,
  ReviewThreadAnchor,
  ReviewThreadBatch,
  ReviewThreadBatchId,
  ReviewThreadTurn,
  ReviewThreadTurnId,
  SnapshotId,
} from "./types.ts";

export const ReviewResponseCandidateSchema = Type.Object(
  {
    batchId: Type.String({
      description: "Identifier of the pending DiffWalk thread batch",
    }),
    turnId: Type.String({
      description: "Identifier of the pending reviewer turn, such as T2",
    }),
    responses: Type.Array(
      Type.Object(
        {
          threadId: Type.String({
            description: "Thread identifier from the pending turn, such as C1",
          }),
          body: Type.String({
            description:
              "Direct response to the latest reviewer message: answer first, then give evidence or applied changes, and end with any uncertainty",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description: "Exactly one response for every thread in the turn",
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
  | "turn-mismatch"
  | "pending-turn"
  | "already-answered"
  | "blank-response"
  | "blank-reply"
  | "duplicate-response"
  | "duplicate-thread"
  | "unknown-comment"
  | "missing-response"
  | "response-required"
  | "resolved-thread"
  | "draft-reply";

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

export interface ReviewThreadFollowUp {
  readonly threadId: ReviewCommentId;
  readonly body: string;
}

export interface AppendReviewThreadTurnInput {
  readonly submissionMode: ReviewSubmissionMode;
  readonly replies: readonly ReviewThreadFollowUp[];
}

export interface ReviewThreadConversationEntry {
  readonly turnId: ReviewThreadTurnId;
  readonly author: "reviewer" | "agent";
  readonly body: string;
}

export function createReviewThreadBatch(
  input: CreateReviewThreadBatchInput,
): ReviewThreadBatch {
  if (input.comments.length === 0) {
    throw new ReviewThreadError(
      "empty-batch",
      "A DiffWalk thread batch requires at least one comment.",
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

  const threads = input.comments.map((comment, index) => ({
    id: `C${index + 1}` as ReviewCommentId,
    anchor: anchorFromComment(comment),
    resolved: false,
  }));
  return {
    id: hashAs<ReviewThreadBatchId>("review-thread-batch", {
      roundId: input.roundId,
    }),
    seriesId: input.seriesId,
    roundId: input.roundId,
    snapshotId: input.snapshotId,
    threads,
    turns: [
      {
        id: "T1" as ReviewThreadTurnId,
        sequence: 1,
        submissionMode: input.submissionMode,
        items: input.comments.map((comment, index) => ({
          threadId: threads[index]?.id ?? (`C${index + 1}` as ReviewCommentId),
          reviewerBody: comment.body,
        })),
      },
    ],
  };
}

export function pendingReviewThreadTurn(
  batch: ReviewThreadBatch,
): ReviewThreadTurn | undefined {
  const latest = batch.turns.at(-1);
  return latest?.items.some((item) => item.agentResponse === undefined)
    ? latest
    : undefined;
}

export function requireThreadTurn(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
): ReviewThreadTurn {
  const turn = batch.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new Error(`DiffWalk batch ${batch.id} has no turn ${turnId}.`);
  }
  return turn;
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
  const pending = pendingReviewThreadTurn(batch);
  if (pending === undefined) {
    throw new ReviewThreadError(
      "already-answered",
      `DiffWalk batch ${batch.id} has no reviewer turn awaiting Agent responses.`,
    );
  }
  if (candidate.turnId !== pending.id) {
    throw new ReviewThreadError(
      "turn-mismatch",
      `Response turn ${candidate.turnId} does not match pending turn ${pending.id} in batch ${batch.id}.`,
    );
  }

  const knownIds = new Set(pending.items.map((item) => item.threadId));
  const responses = new Map<ReviewCommentId, string>();
  for (const response of candidate.responses) {
    if (response.body.trim().length === 0) {
      throw new ReviewThreadError(
        "blank-response",
        `Response for thread ${response.threadId} must not be blank.`,
      );
    }
    if (!knownIds.has(response.threadId as ReviewCommentId)) {
      throw new ReviewThreadError(
        "unknown-comment",
        `Response references unknown thread ${response.threadId} in turn ${pending.id}.`,
      );
    }
    const threadId = response.threadId as ReviewCommentId;
    if (responses.has(threadId)) {
      throw new ReviewThreadError(
        "duplicate-response",
        `Thread ${threadId} has more than one response in turn ${pending.id}.`,
      );
    }
    responses.set(threadId, response.body);
  }

  const missing = pending.items
    .filter((item) => !responses.has(item.threadId))
    .map((item) => item.threadId);
  if (missing.length > 0) {
    throw new ReviewThreadError(
      "missing-response",
      `Turn ${pending.id} is missing responses for: ${missing.join(", ")}.`,
    );
  }

  return {
    ...copyBatch(batch),
    turns: batch.turns.map((turn) =>
      turn.id === pending.id
        ? {
            ...copyTurn(turn),
            items: turn.items.map((item) => ({
              ...copyTurnItem(item),
              agentResponse: { body: responses.get(item.threadId) ?? "" },
            })),
          }
        : copyTurn(turn),
    ),
  };
}

export function setReviewThreadDraft(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
  body: string,
): ReviewThreadBatch {
  if (body.trim().length === 0) {
    throw new ReviewThreadError(
      "blank-reply",
      `Draft reply for thread ${threadId} must not be blank.`,
    );
  }
  assertCanDraftReply(batch, threadId);
  return {
    ...copyBatch(batch),
    threads: batch.threads.map((thread) =>
      thread.id === threadId
        ? { ...copyThread(thread), draftReply: body }
        : copyThread(thread),
    ),
  };
}

export function clearReviewThreadDraft(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): ReviewThreadBatch {
  const thread = requireThread(batch, threadId);
  if (thread.draftReply === undefined) return batch;
  return {
    ...copyBatch(batch),
    threads: batch.threads.map((candidate) => {
      if (candidate.id !== threadId) return copyThread(candidate);
      const { draftReply: _draftReply, ...withoutDraft } =
        copyThread(candidate);
      return withoutDraft;
    }),
  };
}

export function appendReviewThreadTurn(
  batch: ReviewThreadBatch,
  input: AppendReviewThreadTurnInput,
): ReviewThreadBatch {
  const pending = pendingReviewThreadTurn(batch);
  if (pending !== undefined) {
    throw new ReviewThreadError(
      "pending-turn",
      `Turn ${pending.id} must be answered before another reviewer turn is submitted.`,
    );
  }
  if (input.replies.length === 0) {
    throw new ReviewThreadError(
      "empty-batch",
      "A follow-up turn requires at least one reviewer reply.",
    );
  }

  const replies = new Map<ReviewCommentId, string>();
  for (const reply of input.replies) {
    const thread = requireThread(batch, reply.threadId);
    if (thread.resolved) {
      throw new ReviewThreadError(
        "resolved-thread",
        `Thread ${thread.id} must be reopened before adding a follow-up.`,
      );
    }
    if (reply.body.trim().length === 0) {
      throw new ReviewThreadError(
        "blank-reply",
        `Follow-up for thread ${thread.id} must not be blank.`,
      );
    }
    if (replies.has(thread.id)) {
      throw new ReviewThreadError(
        "duplicate-thread",
        `Thread ${thread.id} appears more than once in the follow-up turn.`,
      );
    }
    replies.set(thread.id, reply.body);
  }

  const sequence = batch.turns.length + 1;
  const submittedIds = new Set(replies.keys());
  return {
    ...copyBatch(batch),
    threads: batch.threads.map((thread) => {
      const copied = copyThread(thread);
      if (!submittedIds.has(thread.id)) return copied;
      const { draftReply: _draftReply, ...withoutDraft } = copied;
      return withoutDraft;
    }),
    turns: [
      ...batch.turns.map(copyTurn),
      {
        id: `T${sequence}` as ReviewThreadTurnId,
        sequence,
        submissionMode: input.submissionMode,
        items: batch.threads
          .filter((thread) => replies.has(thread.id))
          .map((thread) => ({
            threadId: thread.id,
            reviewerBody: replies.get(thread.id) ?? "",
          })),
      },
    ],
  };
}

export function setReviewThreadResolved(
  batch: ReviewThreadBatch,
  commentId: ReviewCommentId,
  resolved: boolean,
): ReviewThreadBatch {
  const thread = requireThread(batch, commentId);
  if (!isReviewThreadAnswered(batch, commentId)) {
    throw new ReviewThreadError(
      "response-required",
      `Thread ${commentId} cannot be resolved while its latest reviewer message is unanswered.`,
    );
  }
  if (resolved && thread.draftReply !== undefined) {
    throw new ReviewThreadError(
      "draft-reply",
      `Thread ${commentId} has a draft reply that must be submitted or deleted before resolving.`,
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
      fileChangeId: thread.anchor.fileChangeId,
      side: thread.anchor.side,
      line: thread.anchor.line,
    }));
}

export function isReviewThreadAnswered(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): boolean {
  requireThread(batch, threadId);
  for (let index = batch.turns.length - 1; index >= 0; index -= 1) {
    const item = batch.turns[index]?.items.find(
      (candidate) => candidate.threadId === threadId,
    );
    if (item !== undefined) return item.agentResponse !== undefined;
  }
  return false;
}

export function isReviewThreadBatchAnswered(batch: ReviewThreadBatch): boolean {
  return pendingReviewThreadTurn(batch) === undefined;
}

export function reviewThreadConversation(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): readonly ReviewThreadConversationEntry[] {
  requireThread(batch, threadId);
  const entries: ReviewThreadConversationEntry[] = [];
  for (const turn of batch.turns) {
    const item = turn.items.find(
      (candidate) => candidate.threadId === threadId,
    );
    if (item === undefined) continue;
    entries.push({
      turnId: turn.id,
      author: "reviewer",
      body: item.reviewerBody,
    });
    if (item.agentResponse !== undefined) {
      entries.push({
        turnId: turn.id,
        author: "agent",
        body: item.agentResponse.body,
      });
    }
  }
  return entries;
}

export function copyReviewThreadBatch(
  batch: ReviewThreadBatch,
): ReviewThreadBatch {
  return copyBatch(batch);
}

function assertCanDraftReply(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): void {
  const thread = requireThread(batch, threadId);
  if (thread.resolved) {
    throw new ReviewThreadError(
      "resolved-thread",
      `Thread ${thread.id} must be reopened before adding a follow-up.`,
    );
  }
  const pending = pendingReviewThreadTurn(batch);
  if (pending !== undefined) {
    throw new ReviewThreadError(
      "pending-turn",
      `Turn ${pending.id} must be answered before adding another follow-up.`,
    );
  }
}

function requireThread(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): ReviewThreadBatch["threads"][number] {
  const thread = batch.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) {
    throw new ReviewThreadError(
      "unknown-comment",
      `Batch ${batch.id} has no thread ${threadId}.`,
    );
  }
  return thread;
}

function copyBatch(batch: ReviewThreadBatch): ReviewThreadBatch {
  return {
    ...batch,
    threads: batch.threads.map(copyThread),
    turns: batch.turns.map(copyTurn),
  };
}

function copyThread(
  thread: ReviewThreadBatch["threads"][number],
): ReviewThreadBatch["threads"][number] {
  return {
    ...thread,
    anchor: copyAnchor(thread.anchor),
  };
}

function copyTurn(turn: ReviewThreadTurn): ReviewThreadTurn {
  return {
    ...turn,
    items: turn.items.map(copyTurnItem),
  };
}

function copyTurnItem(
  item: ReviewThreadTurn["items"][number],
): ReviewThreadTurn["items"][number] {
  return {
    ...item,
    ...(item.agentResponse === undefined
      ? {}
      : { agentResponse: { ...item.agentResponse } }),
  };
}

function anchorFromComment(comment: ReviewComment): ReviewThreadAnchor {
  const { body: _body, ...anchor } = comment;
  return copyAnchor(anchor);
}

function copyAnchor(anchor: ReviewThreadAnchor): ReviewThreadAnchor {
  return {
    ...anchor,
    nearbyContext: anchor.nearbyContext.map((line) => ({ ...line })),
  };
}
