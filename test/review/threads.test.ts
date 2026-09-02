import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSession } from "../../src/review/comments.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import {
  appendReviewThreadTurn,
  attachReviewThreadResponses,
  clearReviewThreadDraft,
  createReviewThreadBatch,
  isReviewThreadBatchAnswered,
  pendingReviewThreadTurn,
  ReviewThreadError,
  resolvedCommentLines,
  reviewThreadConversation,
  setReviewThreadDraft,
  setReviewThreadResolved,
} from "../../src/review/threads.ts";
import type {
  ReviewCommentId,
  ReviewRoundId,
  ReviewSeriesId,
} from "../../src/review/types.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";

function makeBatch() {
  const snapshot = makeSnapshot("snapshot-threads", [
    {
      path: "src/a.ts",
      lines: [" head", "+first", " middle", "+second", " tail"],
    },
  ]);
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Thread anchors",
        whyHere: "Both comments belong to this behavior.",
        context: "first -> second",
        changeSummary: "Adds two values.",
        reviewFocus: [{ question: "Are both values correct?" }],
        spans: [span("src/a.ts", { new: [1, 5] })],
      },
    ],
    skippedSpans: [],
  });
  const unit = route.units[0];
  assert.ok(unit);
  const session = new ReviewSession(snapshot, route);
  session.upsertComment({
    reviewUnitId: unit.id,
    fileChangeId: fileChangeId("modified", "src/a.ts"),
    side: "new",
    line: 2,
    body: "Explain the first value.",
  });
  session.upsertComment({
    reviewUnitId: unit.id,
    fileChangeId: fileChangeId("modified", "src/a.ts"),
    side: "new",
    line: 4,
    body: "Explain the second value.",
  });
  return createReviewThreadBatch({
    seriesId: "series-threads" as ReviewSeriesId,
    roundId: "round-threads" as ReviewRoundId,
    snapshotId: snapshot.id,
    submissionMode: "discuss-first",
    comments: session.getComments(),
  });
}

function answerInitialTurn() {
  const batch = makeBatch();
  return attachReviewThreadResponses(batch, {
    batchId: batch.id,
    turnId: "T1",
    responses: [
      { threadId: "C2", body: "Second answer." },
      { threadId: "C1", body: "First answer." },
    ],
  });
}

test("creates deterministic threads and an initial pending turn", () => {
  const first = makeBatch();
  const second = makeBatch();

  assert.equal(first.id, second.id);
  assert.deepEqual(
    first.threads.map((thread) => thread.id),
    ["C1", "C2"],
  );
  assert.deepEqual(
    first.turns.map((turn) => [turn.id, turn.sequence, turn.submissionMode]),
    [["T1", 1, "discuss-first"]],
  );
  assert.deepEqual(
    first.turns[0]?.items.map((item) => [item.threadId, item.reviewerBody]),
    [
      ["C1", "Explain the first value."],
      ["C2", "Explain the second value."],
    ],
  );
  assert.equal(pendingReviewThreadTurn(first)?.id, "T1");
  assert.equal(isReviewThreadBatchAnswered(first), false);
});

test("attaches exactly one structured response to every thread in a turn", () => {
  const batch = makeBatch();
  const answered = answerInitialTurn();

  assert.deepEqual(
    answered.turns[0]?.items.map((item) => item.agentResponse?.body),
    ["First answer.", "Second answer."],
  );
  assert.equal(isReviewThreadBatchAnswered(answered), true);
  assert.equal(batch.turns[0]?.items[0]?.agentResponse, undefined);
});

test("rejects mismatched, missing, duplicate, unknown, blank, stale, and repeated responses", () => {
  const batch = makeBatch();
  const cases: readonly [
    Parameters<typeof attachReviewThreadResponses>[1],
    ReviewThreadError["code"],
  ][] = [
    [{ batchId: "other", turnId: "T1", responses: [] }, "batch-mismatch"],
    [
      {
        batchId: batch.id,
        turnId: "T9",
        responses: [],
      },
      "turn-mismatch",
    ],
    [
      {
        batchId: batch.id,
        turnId: "T1",
        responses: [{ threadId: "C1", body: "Only one." }],
      },
      "missing-response",
    ],
    [
      {
        batchId: batch.id,
        turnId: "T1",
        responses: [
          { threadId: "C1", body: "One." },
          { threadId: "C1", body: "Again." },
        ],
      },
      "duplicate-response",
    ],
    [
      {
        batchId: batch.id,
        turnId: "T1",
        responses: [
          { threadId: "C1", body: "One." },
          { threadId: "C9", body: "Unknown." },
        ],
      },
      "unknown-comment",
    ],
    [
      {
        batchId: batch.id,
        turnId: "T1",
        responses: [
          { threadId: "C1", body: " " },
          { threadId: "C2", body: "Two." },
        ],
      },
      "blank-response",
    ],
  ];

  for (const [candidate, code] of cases) {
    assert.throws(
      () => attachReviewThreadResponses(batch, candidate),
      (error: unknown) => {
        assert.ok(error instanceof ReviewThreadError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }

  const answered = answerInitialTurn();
  assert.throws(
    () =>
      attachReviewThreadResponses(answered, {
        batchId: batch.id,
        turnId: "T1",
        responses: [
          { threadId: "C1", body: "Replacement." },
          { threadId: "C2", body: "Replacement." },
        ],
      }),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "already-answered",
  );
});

test("persists drafts and appends repeated linear conversation turns", () => {
  const answered = answerInitialTurn();
  const withDraft = setReviewThreadDraft(
    answered,
    "C1" as ReviewCommentId,
    "Why is validation needed here?",
  );
  assert.equal(
    withDraft.threads[0]?.draftReply,
    "Why is validation needed here?",
  );

  const pending = appendReviewThreadTurn(withDraft, {
    submissionMode: "apply-change-requests",
    replies: [
      {
        threadId: "C1" as ReviewCommentId,
        body: withDraft.threads[0]?.draftReply ?? "",
      },
    ],
  });
  assert.equal(pending.threads[0]?.draftReply, undefined);
  assert.deepEqual(
    pending.turns.map((turn) => [turn.id, turn.submissionMode]),
    [
      ["T1", "discuss-first"],
      ["T2", "apply-change-requests"],
    ],
  );
  assert.equal(pendingReviewThreadTurn(pending)?.id, "T2");
  assert.throws(
    () =>
      appendReviewThreadTurn(pending, {
        submissionMode: "discuss-first",
        replies: [
          {
            threadId: "C2" as ReviewCommentId,
            body: "Another question.",
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "pending-turn",
  );

  const answeredAgain = attachReviewThreadResponses(pending, {
    batchId: pending.id,
    turnId: "T2",
    responses: [{ threadId: "C1", body: "It rejects malformed input." }],
  });
  assert.deepEqual(
    reviewThreadConversation(answeredAgain, "C1" as ReviewCommentId).map(
      (entry) => [entry.turnId, entry.author, entry.body],
    ),
    [
      ["T1", "reviewer", "Explain the first value."],
      ["T1", "agent", "First answer."],
      ["T2", "reviewer", "Why is validation needed here?"],
      ["T2", "agent", "It rejects malformed input."],
    ],
  );

  const draftAgain = setReviewThreadDraft(
    answeredAgain,
    "C2" as ReviewCommentId,
    "Draft",
  );
  assert.equal(
    clearReviewThreadDraft(draftAgain, "C2" as ReviewCommentId).threads[1]
      ?.draftReply,
    undefined,
  );
});

test("only the reviewer can resolve an answered thread without a draft", () => {
  const batch = makeBatch();
  assert.throws(
    () => setReviewThreadResolved(batch, "C1" as ReviewCommentId, true),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "response-required",
  );

  const answered = answerInitialTurn();
  const withDraft = setReviewThreadDraft(
    answered,
    "C1" as ReviewCommentId,
    "Follow up.",
  );
  assert.throws(
    () => setReviewThreadResolved(withDraft, "C1" as ReviewCommentId, true),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "draft-reply",
  );

  const resolved = setReviewThreadResolved(
    answered,
    "C1" as ReviewCommentId,
    true,
  );
  assert.deepEqual(
    resolved.threads.map((thread) => thread.resolved),
    [true, false],
  );
  assert.deepEqual(resolvedCommentLines(resolved), [
    {
      fileChangeId: fileChangeId("modified", "src/a.ts"),
      side: "new",
      line: 2,
    },
  ]);
  assert.throws(
    () =>
      setReviewThreadDraft(
        resolved,
        "C1" as ReviewCommentId,
        "Cannot reply yet.",
      ),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "resolved-thread",
  );
  assert.equal(
    setReviewThreadResolved(resolved, "C1" as ReviewCommentId, true),
    resolved,
  );
});
