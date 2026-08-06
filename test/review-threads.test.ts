import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSession } from "../src/review-comments.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import {
  attachReviewThreadResponses,
  createReviewThreadBatch,
  isReviewThreadBatchAnswered,
  ReviewThreadError,
  resolvedCommentLines,
  setReviewThreadResolved,
} from "../src/review-threads.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  ReviewCommentId,
  ReviewRoundId,
  ReviewSeriesId,
} from "../src/types.ts";
import { fileChangeId, makeSnapshot, span } from "./domain-fixtures.ts";

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
        reviewFocus: ["Are both values correct?"],
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

test("creates deterministic batch-local comment IDs", () => {
  const first = makeBatch();
  const second = makeBatch();

  assert.equal(first.id, second.id);
  assert.deepEqual(
    first.threads.map((thread) => thread.id),
    ["C1", "C2"],
  );
  assert.equal(
    first.threads.every((thread) => !thread.resolved),
    true,
  );
  assert.equal(isReviewThreadBatchAnswered(first), false);
});

test("attaches exactly one structured response to every comment", () => {
  const batch = makeBatch();
  const answered = attachReviewThreadResponses(batch, {
    batchId: batch.id,
    responses: [
      { commentId: "C2", body: "Second answer." },
      { commentId: "C1", body: "First answer." },
    ],
  });

  assert.deepEqual(
    answered.threads.map((thread) => thread.response?.body),
    ["First answer.", "Second answer."],
  );
  assert.equal(isReviewThreadBatchAnswered(answered), true);
  assert.equal(batch.threads[0]?.response, undefined);
});

test("rejects mismatched, missing, duplicate, unknown, blank, and repeated responses", () => {
  const batch = makeBatch();
  const cases: readonly [
    Parameters<typeof attachReviewThreadResponses>[1],
    ReviewThreadError["code"],
  ][] = [
    [{ batchId: "other", responses: [] }, "batch-mismatch"],
    [
      {
        batchId: batch.id,
        responses: [{ commentId: "C1", body: "Only one." }],
      },
      "missing-response",
    ],
    [
      {
        batchId: batch.id,
        responses: [
          { commentId: "C1", body: "One." },
          { commentId: "C1", body: "Again." },
        ],
      },
      "duplicate-response",
    ],
    [
      {
        batchId: batch.id,
        responses: [
          { commentId: "C1", body: "One." },
          { commentId: "C9", body: "Unknown." },
        ],
      },
      "unknown-comment",
    ],
    [
      {
        batchId: batch.id,
        responses: [
          { commentId: "C1", body: " " },
          { commentId: "C2", body: "Two." },
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

  const answered = attachReviewThreadResponses(batch, {
    batchId: batch.id,
    responses: [
      { commentId: "C1", body: "One." },
      { commentId: "C2", body: "Two." },
    ],
  });
  assert.throws(
    () =>
      attachReviewThreadResponses(answered, {
        batchId: batch.id,
        responses: [
          { commentId: "C1", body: "Replacement." },
          { commentId: "C2", body: "Replacement." },
        ],
      }),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "already-answered",
  );
});

test("only the reviewer can resolve an answered thread", () => {
  const batch = makeBatch();
  assert.throws(
    () => setReviewThreadResolved(batch, "C1" as ReviewCommentId, true),
    (error: unknown) =>
      error instanceof ReviewThreadError && error.code === "response-required",
  );

  const answered = attachReviewThreadResponses(batch, {
    batchId: batch.id,
    responses: [
      { commentId: "C1", body: "One." },
      { commentId: "C2", body: "Two." },
    ],
  });
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
  assert.equal(
    setReviewThreadResolved(resolved, "C1" as ReviewCommentId, true),
    resolved,
  );
});
