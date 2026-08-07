import assert from "node:assert/strict";
import test from "node:test";
import {
  DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
  parseReviewThreadBatchEntry,
  REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
  serializeReviewThreadBatchEntry,
} from "../src/review-thread-persistence.ts";
import type {
  FileChangeId,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewThreadBatch,
  ReviewThreadBatchId,
  ReviewThreadTurnId,
  ReviewUnitId,
  SnapshotId,
} from "../src/types.ts";

function batch(): ReviewThreadBatch {
  return {
    id: "batch-1" as ReviewThreadBatchId,
    seriesId: "series-1" as ReviewSeriesId,
    roundId: "round-1" as ReviewRoundId,
    snapshotId: "snapshot-1" as SnapshotId,
    threads: [
      {
        id: "C1" as ReviewThreadBatch["threads"][number]["id"],
        resolved: true,
        anchor: {
          snapshotId: "snapshot-1" as SnapshotId,
          reviewUnitId: "unit-1" as ReviewUnitId,
          fileChangeId: "file-1" as FileChangeId,
          side: "new",
          line: 2,
          filePath: "src/a.ts",
          oldPath: "src/a.ts",
          newPath: "src/a.ts",
          newLine: 2,
          selectedText: "changed",
          nearbyContext: [
            { type: "context", oldLine: 1, newLine: 1, text: "head" },
            { type: "added", newLine: 2, text: "changed" },
          ],
        },
      },
    ],
    turns: [
      {
        id: "T1" as ReviewThreadTurnId,
        sequence: 1,
        submissionMode: "discuss-first",
        items: [
          {
            threadId: "C1" as ReviewThreadBatch["threads"][number]["id"],
            reviewerBody: "Reviewer comment.",
            agentResponse: { body: "Agent answer." },
          },
        ],
      },
      {
        id: "T2" as ReviewThreadTurnId,
        sequence: 2,
        submissionMode: "apply-change-requests",
        items: [
          {
            threadId: "C1" as ReviewThreadBatch["threads"][number]["id"],
            reviewerBody: "Please update it.",
            agentResponse: { body: "Updated." },
          },
        ],
      },
    ],
  };
}

function obsoleteSingleTurnEntry() {
  return {
    formatVersion: 1,
    batch: {
      id: "batch-legacy",
      seriesId: "series-1",
      roundId: "round-1",
      snapshotId: "snapshot-1",
      submissionMode: "discuss-first",
      threads: [
        {
          id: "C1",
          resolved: true,
          response: { body: "Legacy answer." },
          comment: {
            snapshotId: "snapshot-1",
            reviewUnitId: "unit-1",
            fileChangeId: "file-1",
            side: "new",
            line: 2,
            filePath: "src/a.ts",
            oldPath: "src/a.ts",
            newPath: "src/a.ts",
            newLine: 2,
            selectedText: "changed",
            nearbyContext: [{ type: "added", newLine: 2, text: "changed" }],
            body: "Legacy comment.",
          },
        },
      ],
    },
  } as const;
}

test("round-trips a multi-turn batch through a versioned session entry", () => {
  const value = batch();
  const entry = serializeReviewThreadBatchEntry(value);

  assert.equal(entry.formatVersion, REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION);
  assert.equal(REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION, 1);
  assert.deepEqual(parseReviewThreadBatchEntry(entry), value);
  assert.equal(DIFFWALK_THREAD_BATCH_ENTRY_TYPE, "diffwalk-thread-batch");
});

test("rejects the obsolete pre-release single-turn shape", () => {
  assert.equal(
    parseReviewThreadBatchEntry(obsoleteSingleTurnEntry()),
    undefined,
  );
});

test("rejects incompatible, partial, out-of-order, and structurally invalid entries", () => {
  assert.equal(
    parseReviewThreadBatchEntry({
      ...serializeReviewThreadBatchEntry(batch()),
      formatVersion: 99,
    }),
    undefined,
  );
  assert.equal(parseReviewThreadBatchEntry("bad"), undefined);
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: { ...batch(), threads: [] },
    }),
    undefined,
  );

  const value = batch();
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: {
        ...value,
        threads: value.threads.map((thread) => ({
          ...thread,
          draftReply: "Cannot coexist with resolved.",
        })),
      },
    }),
    undefined,
  );
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: {
        ...value,
        turns: value.turns.map((turn, index) =>
          index === 0
            ? {
                ...turn,
                items: turn.items.map(
                  ({ agentResponse: _agentResponse, ...item }) => item,
                ),
              }
            : turn,
        ),
      },
    }),
    undefined,
  );
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: {
        ...value,
        turns: value.turns.map((turn, index) =>
          index === 1 ? { ...turn, id: "T9" } : turn,
        ),
      },
    }),
    undefined,
  );

  const unresolved = batch();
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: {
        ...unresolved,
        turns: unresolved.turns.map((turn, index) =>
          index === unresolved.turns.length - 1
            ? {
                ...turn,
                items: turn.items.map(
                  ({ agentResponse: _agentResponse, ...item }) => item,
                ),
              }
            : turn,
        ),
      },
    }),
    undefined,
  );
});
