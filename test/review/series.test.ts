import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewCoverage } from "../../src/review/coverage.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  appendReviewRound,
  createReviewRound,
  createReviewSeries,
  getNextReviewRoundIdentity,
  ReviewSeriesError,
} from "../../src/review/series.ts";
import { changedLineKey } from "../../src/review/span.ts";
import type {
  ChangedLineRecord,
  ReviewCoverage,
  ReviewDelta,
  ReviewRound,
  ReviewRoundUnit,
  ReviewSeries,
  ReviewSnapshot,
} from "../../src/review/types.ts";
import {
  makeRound,
  makeSnapshot,
  roundId,
} from "../support/domain-fixtures.ts";

function series(
  overrides: Partial<Parameters<typeof createReviewSeries>[0]> = {},
) {
  return createReviewSeries({
    repositoryRoot: "/repo",
    sourceBranch: "feature",
    targetRef: "main",
    ...overrides,
  });
}

function snapshotOf(id: string, added = "value"): ReviewSnapshot {
  return makeSnapshot(id, [
    { path: "src/a.ts", lines: [" head", `+${added}`, " tail"] },
  ]);
}

function roundFor(
  base: ReviewSeries,
  snapshot: ReviewSnapshot,
  delta: ReviewDelta = computeReviewDelta(snapshot),
): ReviewRound {
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });
  return createReviewRound(base, snapshot, delta, coverage);
}

function withRecords(
  coverage: ReviewCoverage,
  map: (record: ChangedLineRecord) => ChangedLineRecord,
): ReviewCoverage {
  return {
    ...coverage,
    files: coverage.files.map((file) => ({
      ...file,
      lines: file.lines.map(map),
    })),
  };
}

test("rejects empty series identity values", () => {
  assert.throws(() => series({ repositoryRoot: "  " }), ReviewSeriesError);
  assert.throws(() => series({ sourceBranch: "" }), ReviewSeriesError);
  assert.throws(() => series({ targetRef: "\t" }), ReviewSeriesError);
});

test("creates deterministic series IDs from repository, branch, and target", () => {
  assert.equal(series().id, series().id);
  assert.notEqual(series().id, series({ sourceBranch: "other" }).id);
  assert.notEqual(series().id, series({ targetRef: "develop" }).id);
  assert.notEqual(series().id, series({ repositoryRoot: "/other" }).id);
});

test("creates and appends sequential completed rounds", () => {
  const base = series();
  const first = snapshotOf("snapshot-1");
  const firstRound = roundFor(base, first);
  const afterFirst = appendReviewRound(base, firstRound);

  assert.equal(firstRound.sequence, 1);
  assert.equal(afterFirst.rounds.length, 1);
  assert.deepEqual(base.rounds, []);

  const second = snapshotOf("snapshot-2", "changed");
  const secondDelta = computeReviewDelta(second, firstRound);
  const secondRound = roundFor(afterFirst, second, secondDelta);
  const afterSecond = appendReviewRound(afterFirst, secondRound);

  assert.equal(secondRound.sequence, 2);
  assert.equal(secondRound.delta.baselineRoundId, firstRound.id);
  assert.equal(afterSecond.rounds.length, 2);
  assert.notEqual(secondRound.id, firstRound.id);
});

test("rejects snapshots that do not belong to the series", () => {
  const base = series();
  const foreignRoot = makeSnapshot(
    "snapshot-foreign",
    [{ path: "src/a.ts", lines: [" head", "+value", " tail"] }],
    { repositoryRoot: "/other" },
  );
  const foreignTarget = makeSnapshot(
    "snapshot-target",
    [{ path: "src/a.ts", lines: [" head", "+value", " tail"] }],
    { targetRef: "develop" },
  );

  assert.throws(
    () => getNextReviewRoundIdentity(base, foreignRoot),
    ReviewSeriesError,
  );
  assert.throws(
    () => getNextReviewRoundIdentity(base, foreignTarget),
    ReviewSeriesError,
  );
});

test("rejects a round whose coverage does not match the snapshot lines", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const delta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  assert.throws(
    () =>
      createReviewRound(base, snapshot, delta, {
        ...coverage,
        snapshotId: "other" as never,
      }),
    ReviewSeriesError,
  );

  assert.throws(
    () =>
      createReviewRound(base, snapshot, delta, {
        ...coverage,
        files: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /does not cover changed file src\/a\.ts/);
      return true;
    },
  );

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        delta,
        withRecords(coverage, (record) => ({ ...record, line: 99 })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /does not match snapshot new line 2/);
      return true;
    },
  );

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        delta,
        withRecords(coverage, (record) => ({ ...record, text: "tampered" })),
      ),
    ReviewSeriesError,
  );
});

test("rejects coverage for a file with no changed lines in the snapshot", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const delta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });
  const extra = coverage.files[0];
  assert.ok(extra);

  assert.throws(
    () =>
      createReviewRound(base, snapshot, delta, {
        ...coverage,
        files: [...coverage.files, { ...extra, newPath: "src/ghost.ts" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /no changed lines in the snapshot/);
      return true;
    },
  );
});

test("rejects a delta baseline that does not match the series history", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const delta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        { ...delta, baselineRoundId: roundId("round-ghost") },
        coverage,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /baseline/);
      return true;
    },
  );
});

test("rejects disposition provenance that does not reference the current round", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const delta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        delta,
        withRecords(coverage, (record) => ({
          side: record.side,
          line: record.line,
          text: record.text,
          disposition: "commented",
          commentedInRoundId: roundId("round-other"),
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /must reference current round/);
      return true;
    },
  );

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        delta,
        withRecords(coverage, (record) => ({
          side: record.side,
          line: record.line,
          text: record.text,
          disposition: "skipped",
          skippedInRoundId: identity.id,
          skipReason: "  ",
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /non-empty reason/);
      return true;
    },
  );
});

test("rejects skipping a carried-forward line in a round", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const withHistory = appendReviewRound(base, roundFor(base, snapshot));
  const delta = computeReviewDelta(snapshot, withHistory.rounds[0]);
  const identity = getNextReviewRoundIdentity(withHistory, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  assert.throws(
    () =>
      createReviewRound(
        withHistory,
        snapshot,
        delta,
        withRecords(coverage, (record) => ({
          side: record.side,
          line: record.line,
          text: record.text,
          disposition: "skipped",
          skippedInRoundId: identity.id,
          skipReason: "Skip.",
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /Carried-forward/);
      return true;
    },
  );
});

test("rejects carried coverage that references a round outside the series", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const foreign = makeRound({ id: "round-foreign", snapshot });
  const delta = computeReviewDelta(snapshot, foreign);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });

  assert.throws(
    () => createReviewRound(base, snapshot, delta, coverage),
    ReviewSeriesError,
  );
});

test("rejects invalid round identity when appending", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const round = roundFor(base, snapshot);

  assert.throws(
    () => appendReviewRound(base, { ...round, id: roundId("wrong") }),
    ReviewSeriesError,
  );
  assert.throws(
    () => appendReviewRound(base, { ...round, sequence: 5 }),
    ReviewSeriesError,
  );
  assert.throws(
    () =>
      appendReviewRound(base, {
        ...round,
        seriesId: "other-series" as never,
      }),
    ReviewSeriesError,
  );
});

test("rejects malformed existing series history", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const round = roundFor(base, snapshot);
  const withRound = appendReviewRound(base, round);

  assert.throws(
    () =>
      getNextReviewRoundIdentity(
        { ...withRound, rounds: [{ ...round, sequence: 7 }] },
        snapshot,
      ),
    ReviewSeriesError,
  );
  assert.throws(
    () =>
      getNextReviewRoundIdentity(
        { ...withRound, rounds: [round, round] },
        snapshot,
      ),
    ReviewSeriesError,
  );
});

test("requires excluded requirements and excluded records to agree", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const change = snapshot.changes[0];
  assert.ok(change);
  const key = changedLineKey({ fileChangeId: change.id, side: "new", line: 2 });
  const excludedDelta = computeReviewDelta(snapshot, undefined, {
    exclusions: new Map([[key, { reason: "whitespace-only" as const }]]),
  });
  const plainDelta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);

  const excludedCoverage = computeReviewCoverage(
    identity.id,
    snapshot,
    excludedDelta,
    { commentedLines: [], skippedSpans: [] },
  );
  const round = createReviewRound(
    base,
    snapshot,
    excludedDelta,
    excludedCoverage,
  );
  assert.equal(round.coverage.files[0]?.lines[0]?.disposition, "excluded");

  assert.throws(
    () => createReviewRound(base, snapshot, plainDelta, excludedCoverage),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /must correspond to an excluded/);
      return true;
    },
  );

  const plainCoverage = computeReviewCoverage(
    identity.id,
    snapshot,
    plainDelta,
    { commentedLines: [], skippedSpans: [] },
  );
  assert.throws(
    () => createReviewRound(base, snapshot, excludedDelta, plainCoverage),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /must be recorded as excluded/);
      return true;
    },
  );

  assert.throws(
    () =>
      createReviewRound(
        base,
        snapshot,
        excludedDelta,
        withRecords(excludedCoverage, (record) => ({
          side: record.side,
          line: record.line,
          text: record.text,
          disposition: "excluded",
          excludedInRoundId: roundId("round-other"),
          exclusionReason: "whitespace-only",
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSeriesError);
      assert.match(error.message, /must reference current round/);
      return true;
    },
  );
});

test("validates round unit outcomes against their skip", () => {
  const base = series();
  const snapshot = snapshotOf("snapshot-1");
  const delta = computeReviewDelta(snapshot);
  const identity = getNextReviewRoundIdentity(base, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });
  const unit = (overrides: Partial<ReviewRoundUnit>): ReviewRoundUnit => ({
    id: "review-unit:1" as ReviewRoundUnit["id"],
    title: "Unit",
    routine: false,
    outcome: "reviewed",
    commented: false,
    ...overrides,
  });

  const round = createReviewRound(base, snapshot, delta, coverage, [
    unit({}),
    unit({
      id: "review-unit:2" as ReviewRoundUnit["id"],
      routine: true,
      skip: { source: "agent", reasons: ["Same shape."] },
      outcome: "skipped",
    }),
    unit({
      id: "review-unit:3" as ReviewRoundUnit["id"],
      skip: {
        source: "typesafe",
        reasons: ["No behavior change."],
        features: {
          changesBehavior: 0.1,
          newControlFlow: 0.05,
          touchesBoundary: { choice: "none", confidence: 0.9 },
          kind: { choice: "refactor", confidence: 0.8 },
        },
      },
      outcome: "skipped",
    }),
  ]);
  assert.equal(round.units.length, 3);
  assert.equal(appendReviewRound(base, round).rounds[0]?.units.length, 3);

  const agentSkip = { source: "agent" as const, reasons: ["Same shape."] };
  const cases: readonly [Partial<ReviewRoundUnit>[], RegExp][] = [
    [[{}, {}], /more than once/],
    [[{ title: " " }], /requires a title/],
    [[{ outcome: "skipped" }], /skipped without recording who decided/],
    [
      [{ routine: true, outcome: "skipped" }],
      /skipped without recording who decided/,
    ],
    [[{ skip: agentSkip }], /records a skip but has outcome reviewed/],
  ];
  for (const [units, pattern] of cases) {
    assert.throws(
      () => createReviewRound(base, snapshot, delta, coverage, units.map(unit)),
      (error: unknown) => {
        assert.ok(error instanceof ReviewSeriesError);
        assert.match(error.message, pattern);
        return true;
      },
    );
  }
});
