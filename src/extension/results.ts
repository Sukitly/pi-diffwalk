import {
  REVIEW_RESPONSES_TOOL_NAME,
  reviewThreadConversation,
} from "../review/threads.ts";
import type {
  GuidedReviewResult,
  ReviewThreadBatch,
  ReviewThreadTurnId,
} from "../review/types.ts";

/**
 * Model-facing payloads. They reach the LLM verbatim as tool results or
 * message content, so their shape is part of the prompt surface and is
 * covered by the golden fixture.
 */

export function shouldSendReviewToAgent(result: GuidedReviewResult): boolean {
  return result.status === "submitted" && result.comments.length > 0;
}

export function requireThreadTurn(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
): ReviewThreadBatch["turns"][number] {
  const turn = batch.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new Error(`DiffWalk batch ${batch.id} has no turn ${turnId}.`);
  }
  return turn;
}

export function formatReviewThreadFollowUp(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
): string {
  const turn = requireThreadTurn(batch, turnId);
  return JSON.stringify({
    status: "review-thread-follow-up",
    commentBatchId: batch.id,
    turnId: turn.id,
    submissionMode: turn.submissionMode,
    threads: turn.items.map((item) => {
      const thread = batch.threads.find(
        (candidate) => candidate.id === item.threadId,
      );
      if (thread === undefined) {
        throw new Error(
          `DiffWalk turn ${turn.id} references missing thread ${item.threadId}.`,
        );
      }
      return {
        threadId: thread.id,
        anchor: thread.anchor,
        conversation: reviewThreadConversation(batch, thread.id),
      };
    }),
    instruction:
      turn.submissionMode === "discuss-first"
        ? `Investigate every pending reviewer follow-up without modifying files. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId. The tool reopens the anchored conversations for the reviewer.`
        : `Apply direct change requests and investigate questions or disagreements in every pending reviewer follow-up. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId, explaining any applied change, uncertainty, or disagreement. The tool reopens the anchored conversations for the reviewer.`,
  });
}

export function formatGuidedReviewResult(result: GuidedReviewResult): string {
  if (result.status === "paused") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
      instruction:
        "The review is paused. Follow the user's next request normally, including requests to modify repository files or Git state. Progress and draft comments remain resumable only while the repository matches the frozen snapshot; the next /diffwalk discards a stale review and starts from a fresh snapshot.",
    });
  }
  if (result.status === "discarded") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
      instruction:
        "The user discarded the review without submitting comments. Wait for the user's direction before acting on the change.",
    });
  }
  const turnId = result.commentTurnId ?? ("T1" as ReviewThreadTurnId);
  return JSON.stringify({
    status: result.status,
    snapshotId: result.snapshotId,
    submissionMode: result.submissionMode,
    ...(result.commentBatchId === undefined
      ? {}
      : { commentBatchId: result.commentBatchId, turnId }),
    comments: result.comments.map((comment, index) => ({
      threadId: `C${index + 1}`,
      ...comment,
    })),
    instruction:
      result.comments.length === 0
        ? "No comments require an Agent response."
        : result.submissionMode === "discuss-first"
          ? `Investigate every comment without modifying files. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId. The tool opens the anchored conversations for the reviewer.`
          : `Apply direct change requests and investigate questions or disagreements. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId, explaining any applied change, uncertainty, or disagreement. The tool opens the anchored conversations for the reviewer.`,
  });
}
