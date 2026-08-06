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
  ReviewUnitId,
  SnapshotId,
} from "../src/types.ts";

function batch(): ReviewThreadBatch {
  return {
    id: "batch-1" as ReviewThreadBatchId,
    seriesId: "series-1" as ReviewSeriesId,
    roundId: "round-1" as ReviewRoundId,
    snapshotId: "snapshot-1" as SnapshotId,
    submissionMode: "discuss-first",
    threads: [
      {
        id: "C1" as ReviewThreadBatch["threads"][number]["id"],
        resolved: true,
        response: { body: "Agent answer." },
        comment: {
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
          body: "Reviewer comment.",
        },
      },
    ],
  };
}

test("round-trips a thread batch through a versioned session entry", () => {
  const value = batch();
  const entry = serializeReviewThreadBatchEntry(value);

  assert.equal(entry.formatVersion, REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION);
  assert.deepEqual(parseReviewThreadBatchEntry(entry), value);
  assert.equal(DIFFWALK_THREAD_BATCH_ENTRY_TYPE, "diffwalk-thread-batch");
});

test("rejects incompatible and structurally invalid thread entries", () => {
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
  const unresolved = batch();
  assert.equal(
    parseReviewThreadBatchEntry({
      formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION,
      batch: {
        ...unresolved,
        threads: unresolved.threads.map(
          ({ response: _response, ...thread }) => ({
            ...thread,
            resolved: true,
          }),
        ),
      },
    }),
    undefined,
  );
});
