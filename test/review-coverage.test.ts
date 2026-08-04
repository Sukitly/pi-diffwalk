import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReviewCoverage,
  ReviewCoverageError,
} from "../src/review-coverage.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  ChangedLineRecord,
  ReviewCoverage,
  ReviewRoute,
  ReviewSnapshot,
} from "../src/types.ts";
import {
  fileChangeId,
  makeRound,
  makeSnapshot,
  roundId,
  span,
} from "./domain-fixtures.ts";

const ROUND = roundId("round-current");

function fixture(): ReviewSnapshot {
  return makeSnapshot("snapshot-coverage", [
    { path: "src/entry.ts", lines: [" head", "-old", "+new", " tail"] },
    { path: "src/contract.ts", lines: [" head", "+value", " tail"] },
  ]);
}

function routeFor(
  snapshot: ReviewSnapshot,
  skipped: readonly { path: string; line: number; reason: string }[] = [],
): ReviewRoute {
  const delta = computeReviewDelta(snapshot);
  const skippedPaths = new Set(skipped.map((entry) => entry.path));
  const units = [
    ...(skippedPaths.has("src/entry.ts")
      ? []
      : [
          {
            title: "Entry",
            whyHere: "Behavior starts here.",
            context: "entry",
            changeSummary: "Replaces the legacy call.",
            reviewFocus: ["Is it correct?"],
            spans: [span("src/entry.ts", { old: [2, 2], new: [2, 2] })],
          },
        ]),
    ...(skippedPaths.has("src/contract.ts")
      ? []
      : [
          {
            title: "Contract",
            whyHere: "The entry depends on it.",
            context: "contract",
            changeSummary: "Adds a field.",
            reviewFocus: ["Is it compatible?"],
            spans: [span("src/contract.ts", { new: [2, 2] })],
          },
        ]),
  ];
  return validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units,
    skippedSpans: skipped.map((entry) => ({
      span: span(entry.path, { new: [entry.line, entry.line] }),
      reason: entry.reason,
    })),
  });
}

function recordsOf(
  coverage: ReviewCoverage,
  path: string,
): readonly ChangedLineRecord[] {
  return (
    coverage.files.find((file) => (file.newPath ?? file.oldPath) === path)
      ?.lines ?? []
  );
}

test("records every changed line of every changed file", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  const coverage = computeReviewCoverage(ROUND, snapshot, delta, {
    commentedLines: [],
    skippedSpans: routeFor(snapshot).skippedSpans,
  });

  assert.equal(coverage.snapshotId, snapshot.id);
  assert.deepEqual(
    coverage.files.map((file) => file.newPath),
    ["src/entry.ts", "src/contract.ts"],
  );
  assert.deepEqual(
    recordsOf(coverage, "src/entry.ts").map((record) => [
      record.side,
      record.line,
      record.text,
      record.disposition,
    ]),
    [
      ["old", 2, "old", "reviewed-without-comment"],
      ["new", 2, "new", "reviewed-without-comment"],
    ],
  );
});

test("marks commented lines and attributes them to the current round", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  const coverage = computeReviewCoverage(ROUND, snapshot, delta, {
    commentedLines: [
      {
        fileChangeId: fileChangeId("modified", "src/entry.ts"),
        side: "new",
        line: 2,
      },
    ],
    skippedSpans: [],
  });

  const record = recordsOf(coverage, "src/entry.ts")[1];
  assert.equal(record?.disposition, "commented");
  assert.equal(
    record?.disposition === "commented" ? record.commentedInRoundId : undefined,
    ROUND,
  );
});

test("marks skipped lines with their visible reason", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const route = routeFor(snapshot, [
    {
      path: "src/contract.ts",
      line: 2,
      reason: "Generated surface reviewed at its source.",
    },
  ]);

  const coverage = computeReviewCoverage(ROUND, snapshot, delta, {
    commentedLines: [],
    skippedSpans: route.skippedSpans,
  });

  const record = recordsOf(coverage, "src/contract.ts")[0];
  assert.equal(record?.disposition, "skipped");
  assert.equal(
    record?.disposition === "skipped" ? record.skipReason : undefined,
    "Generated surface reviewed at its source.",
  );
});

test("attributes a carried-forward line to the round that reviewed it", () => {
  const snapshot = fixture();
  const baseline = makeRound({ id: "round-1", snapshot });
  const delta = computeReviewDelta(snapshot, baseline);

  const coverage = computeReviewCoverage(ROUND, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  const record = recordsOf(coverage, "src/entry.ts")[0];
  assert.equal(record?.disposition, "reviewed-without-comment");
  assert.equal(
    record?.disposition === "reviewed-without-comment"
      ? record.reviewedInRoundId
      : undefined,
    "round-1",
  );
});

test("rejects a comment on a line that is not a changed line", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, delta, {
        commentedLines: [
          {
            fileChangeId: fileChangeId("modified", "src/entry.ts"),
            side: "new",
            line: 1,
          },
        ],
        skippedSpans: [],
      }),
    ReviewCoverageError,
  );
});

test("rejects skipping a carried-forward line", () => {
  const snapshot = fixture();
  const baseline = makeRound({ id: "round-1", snapshot });
  const delta = computeReviewDelta(snapshot, baseline);
  const skippedSpans = routeFor(snapshot, [
    { path: "src/contract.ts", line: 2, reason: "Skip." },
  ]).skippedSpans;

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, delta, {
        commentedLines: [],
        skippedSpans,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewCoverageError);
      assert.match(error.message, /carried forward and cannot be skipped/);
      return true;
    },
  );
});

test("rejects skipping a line whose earlier comment is unresolved", () => {
  const snapshot = fixture();
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/contract.ts:new:2": "commented" },
  });
  const delta = computeReviewDelta(snapshot, baseline);
  const skippedSpans = routeFor(snapshot, [
    { path: "src/contract.ts", line: 2, reason: "Skip." },
  ]).skippedSpans;

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, delta, {
        commentedLines: [],
        skippedSpans,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewCoverageError);
      assert.match(error.message, /unresolved comment/);
      return true;
    },
  );
});

test("rejects a blank skip reason and a line that is both commented and skipped", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const skippedSpans = routeFor(snapshot, [
    { path: "src/contract.ts", line: 2, reason: "Skip." },
  ]).skippedSpans;
  const blank = skippedSpans.map((skip) => ({ ...skip, reason: "  " }));

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, delta, {
        commentedLines: [],
        skippedSpans: blank,
      }),
    ReviewCoverageError,
  );

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, delta, {
        commentedLines: [
          {
            fileChangeId: fileChangeId("modified", "src/contract.ts"),
            side: "new",
            line: 2,
          },
        ],
        skippedSpans,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewCoverageError);
      assert.match(error.message, /both commented and skipped/);
      return true;
    },
  );
});

test("rejects a delta that does not match the snapshot", () => {
  const snapshot = fixture();
  const other = makeSnapshot("snapshot-other", [
    { path: "src/entry.ts", lines: [" head", "+different", " tail"] },
  ]);

  assert.throws(
    () =>
      computeReviewCoverage(ROUND, snapshot, computeReviewDelta(other), {
        commentedLines: [],
        skippedSpans: [],
      }),
    Error,
  );
});
