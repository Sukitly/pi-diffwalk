import assert from "node:assert/strict";
import test from "node:test";
import {
  alignSequences,
  assertReviewDeltaMatchesSnapshot,
  computeReviewDelta,
  isNeedsReviewReasonSkippable,
  ReviewDeltaError,
} from "../src/review-delta.ts";
import { changedLineKey } from "../src/review-span.ts";
import type { ChangedLineRequirement, ReviewSnapshot } from "../src/types.ts";
import { makeRound, makeSnapshot } from "./domain-fixtures.ts";

function requirementFor(
  delta: { readonly lines: readonly ChangedLineRequirement[] },
  snapshot: ReviewSnapshot,
  path: string,
  side: "old" | "new",
  line: number,
): ChangedLineRequirement | undefined {
  const change = snapshot.changes.find(
    (candidate) => (candidate.newPath ?? candidate.oldPath) === path,
  );
  if (change === undefined) return undefined;
  const key = changedLineKey({ fileChangeId: change.id, side, line });
  return delta.lines.find((requirement) => changedLineKey(requirement) === key);
}

function summarize(delta: {
  readonly lines: readonly ChangedLineRequirement[];
}): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of delta.lines) {
    const label =
      line.type === "carried-forward" ? "carried-forward" : line.reason;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

test("treats every changed line as new when there is no baseline", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "-old", "+new", " tail"] },
  ]);

  const delta = computeReviewDelta(snapshot);

  assert.equal(delta.baselineRoundId, undefined);
  assert.deepEqual(summarize(delta), { new: 2 });
  assert.equal(delta.removedLineCount, 0);
});

test("carries forward every line when the snapshot did not change", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "-old", "+new", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot });

  const delta = computeReviewDelta(snapshot, baseline);

  assert.equal(delta.baselineRoundId, "round-1");
  assert.deepEqual(summarize(delta), { "carried-forward": 2 });
  assert.equal(delta.removedLineCount, 0);
});

test("keeps a reviewed line carried forward after unrelated lines shift it", () => {
  const before = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+reviewed", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot: before });
  const after = makeSnapshot("snapshot-2", [
    {
      path: "src/a.ts",
      lines: [" keep", "+inserted above", "+reviewed", " tail"],
    },
  ]);

  const delta = computeReviewDelta(after, baseline);

  assert.equal(
    requirementFor(delta, after, "src/a.ts", "new", 3)?.type,
    "carried-forward",
  );
  const inserted = requirementFor(delta, after, "src/a.ts", "new", 2);
  assert.equal(inserted?.type, "needs-review");
  assert.equal(
    inserted?.type === "needs-review" ? inserted.reason : undefined,
    "new",
  );
});

test("keeps a reviewed line carried forward when a neighbour changes", () => {
  const before = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+reviewed", "+neighbour", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot: before });
  const after = makeSnapshot("snapshot-2", [
    { path: "src/a.ts", lines: [" keep", "+reviewed", "+rewritten", " tail"] },
  ]);

  const delta = computeReviewDelta(after, baseline);

  assert.deepEqual(summarize(delta), { "carried-forward": 1, new: 1 });
  assert.equal(
    requirementFor(delta, after, "src/a.ts", "new", 2)?.type,
    "carried-forward",
  );
});

test("reopens a line whose earlier comment is unresolved", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+commented", "+clean", " tail"] },
  ]);
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/a.ts:new:2": "commented" },
  });

  const delta = computeReviewDelta(snapshot, baseline);

  const reopened = requirementFor(delta, snapshot, "src/a.ts", "new", 2);
  assert.equal(
    reopened?.type === "needs-review" ? reopened.reason : undefined,
    "unresolved-comment",
  );
  assert.equal(
    requirementFor(delta, snapshot, "src/a.ts", "new", 3)?.type,
    "carried-forward",
  );
});

test("carries forward a commented line after the reviewer resolves its thread", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+commented", "+clean", " tail"] },
  ]);
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/a.ts:new:2": "commented" },
  });
  const change = snapshot.changes[0];
  assert.ok(change);

  const delta = computeReviewDelta(snapshot, baseline, {
    resolvedCommentLines: [{ fileChangeId: change.id, side: "new", line: 2 }],
  });

  assert.equal(
    requirementFor(delta, snapshot, "src/a.ts", "new", 2)?.type,
    "carried-forward",
  );
  assert.deepEqual(summarize(delta), { "carried-forward": 2 });
});

test("rejects a resolved-thread anchor that was not commented in the baseline", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+reviewed", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot });
  const change = snapshot.changes[0];
  assert.ok(change);

  assert.throws(
    () =>
      computeReviewDelta(snapshot, baseline, {
        resolvedCommentLines: [
          { fileChangeId: change.id, side: "new", line: 2 },
        ],
      }),
    /not commented in baseline round/,
  );
});

test("reopens a previously skipped line", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+skipped", " tail"] },
  ]);
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/a.ts:new:2": "skipped" },
  });

  const delta = computeReviewDelta(snapshot, baseline);

  const reopened = requirementFor(delta, snapshot, "src/a.ts", "new", 2);
  assert.equal(
    reopened?.type === "needs-review" ? reopened.reason : undefined,
    "previously-skipped",
  );
});

test("counts baseline lines that no longer exist", () => {
  const before = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+first", "+second", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot: before });
  const after = makeSnapshot("snapshot-2", [
    { path: "src/a.ts", lines: [" keep", "+first", " tail"] },
  ]);

  const delta = computeReviewDelta(after, baseline);

  assert.deepEqual(summarize(delta), { "carried-forward": 1 });
  assert.equal(delta.removedLineCount, 1);
});

test("counts every line of a file that stopped changing", () => {
  const before = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+a", " tail"] },
    { path: "src/b.ts", lines: [" keep", "+b", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot: before });
  const after = makeSnapshot("snapshot-2", [
    { path: "src/a.ts", lines: [" keep", "+a", " tail"] },
  ]);

  const delta = computeReviewDelta(after, baseline);

  assert.deepEqual(summarize(delta), { "carried-forward": 1 });
  assert.equal(delta.removedLineCount, 1);
});

test("treats a file that changed path as entirely new", () => {
  const before = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+value", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot: before });
  const after = makeSnapshot("snapshot-2", [
    { path: "src/renamed.ts", lines: [" keep", "+value", " tail"] },
  ]);

  const delta = computeReviewDelta(after, baseline);

  assert.deepEqual(summarize(delta), { new: 1 });
  assert.equal(delta.removedLineCount, 1);
});

test("distinguishes identical text on the old and new side", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: ["-same", "+same"] },
  ]);
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/a.ts:old:1": "commented" },
  });

  const delta = computeReviewDelta(snapshot, baseline);

  const removed = requirementFor(delta, snapshot, "src/a.ts", "old", 1);
  assert.equal(
    removed?.type === "needs-review" ? removed.reason : undefined,
    "unresolved-comment",
  );
  assert.equal(
    requirementFor(delta, snapshot, "src/a.ts", "new", 1)?.type,
    "carried-forward",
  );
});

test("aligns sequences by longest common subsequence", () => {
  assert.deepEqual(alignSequences(["a", "b", "c"], ["a", "b", "c"]), [
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  assert.deepEqual(alignSequences(["a", "x", "c"], ["a", "c"]), [
    [0, 0],
    [2, 1],
  ]);
  assert.deepEqual(alignSequences([], ["a"]), []);
  assert.deepEqual(alignSequences(["a"], []), []);
});

test("validates that a delta covers exactly the snapshot changed lines", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+one", "+two", " tail"] },
  ]);
  const delta = computeReviewDelta(snapshot);

  assert.doesNotThrow(() => assertReviewDeltaMatchesSnapshot(snapshot, delta));

  assert.throws(
    () =>
      assertReviewDeltaMatchesSnapshot(snapshot, {
        ...delta,
        currentSnapshotId: snapshot.id,
        lines: delta.lines.slice(0, 1),
      }),
    ReviewDeltaError,
  );

  const first = delta.lines[0];
  assert.ok(first);
  assert.throws(
    () =>
      assertReviewDeltaMatchesSnapshot(snapshot, {
        ...delta,
        lines: [first, first],
      }),
    ReviewDeltaError,
  );

  assert.throws(
    () =>
      assertReviewDeltaMatchesSnapshot(snapshot, {
        ...delta,
        lines: [{ ...first, line: 99 }],
      }),
    ReviewDeltaError,
  );
});

test("rejects a baseline round whose coverage does not match its snapshot", () => {
  const snapshot = makeSnapshot("snapshot-1", [
    { path: "src/a.ts", lines: [" keep", "+one", " tail"] },
  ]);
  const baseline = makeRound({ id: "round-1", snapshot });

  assert.throws(
    () =>
      computeReviewDelta(snapshot, {
        ...baseline,
        coverage: { ...baseline.coverage, snapshotId: "other" as never },
      }),
    ReviewDeltaError,
  );
});

test("only an unresolved comment blocks skipping", () => {
  assert.equal(isNeedsReviewReasonSkippable("new"), true);
  assert.equal(isNeedsReviewReasonSkippable("previously-skipped"), true);
  assert.equal(isNeedsReviewReasonSkippable("unresolved-comment"), false);
});
