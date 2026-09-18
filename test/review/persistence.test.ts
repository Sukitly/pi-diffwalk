import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewCoverage } from "../../src/review/coverage.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  DIFFWALK_SERIES_ENTRY_TYPE,
  parseReviewSeriesEntry,
  serializeReviewSeriesEntry,
} from "../../src/review/persistence.ts";
import {
  appendReviewRound,
  createReviewRound,
  createReviewSeries,
  getNextReviewRoundIdentity,
} from "../../src/review/series.ts";
import { changedLineKey } from "../../src/review/span.ts";
import type { ReviewRoundUnit, ReviewSeries } from "../../src/review/types.ts";
import { makeSnapshot } from "../support/domain-fixtures.ts";

/** A domain-consistent one-round series built through the real pipeline. */
function makeSubmittedSeries(): ReviewSeries {
  const snapshot = makeSnapshot("snapshot-persist", [
    { path: "src/file.ts", lines: [" head", "+changed", "-old", " tail"] },
  ]);
  const series = createReviewSeries({
    repositoryRoot: snapshot.repositoryRoot,
    sourceBranch: "main",
    targetRef: "main",
  });
  const delta = computeReviewDelta(snapshot, undefined);
  const identity = getNextReviewRoundIdentity(series, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });
  const round = createReviewRound(series, snapshot, delta, coverage);
  return appendReviewRound(series, round);
}

test("round-trips a submitted series through JSON", () => {
  const series = makeSubmittedSeries();
  const entry = serializeReviewSeriesEntry(series);
  assert.equal(entry.formatVersion, 1);

  const revived = parseReviewSeriesEntry(
    JSON.parse(JSON.stringify(entry)) as unknown,
  );
  assert.deepEqual(revived, series);
});

test("names a stable entry type for session storage", () => {
  assert.equal(DIFFWALK_SERIES_ENTRY_TYPE, "diffwalk-series");
});

test("rejects entries with a different format version", () => {
  const entry = serializeReviewSeriesEntry(makeSubmittedSeries());
  const stale = { ...JSON.parse(JSON.stringify(entry)), formatVersion: 2 };
  assert.equal(parseReviewSeriesEntry(stale), undefined);
});

test("rejects non-object and structurally broken entries", () => {
  assert.equal(parseReviewSeriesEntry(undefined), undefined);
  assert.equal(parseReviewSeriesEntry(null), undefined);
  assert.equal(parseReviewSeriesEntry("garbage"), undefined);
  assert.equal(parseReviewSeriesEntry({ formatVersion: 1 }), undefined);

  const entry = JSON.parse(
    JSON.stringify(serializeReviewSeriesEntry(makeSubmittedSeries())),
  ) as {
    formatVersion: number;
    series: {
      rounds: {
        sequence: unknown;
        delta: { lines: { type: unknown }[] };
      }[];
    };
  };

  const badSequence = JSON.parse(JSON.stringify(entry)) as typeof entry;
  const sequenceRound = badSequence.series.rounds[0];
  assert.ok(sequenceRound);
  sequenceRound.sequence = "1";
  assert.equal(parseReviewSeriesEntry(badSequence), undefined);

  const badRequirement = JSON.parse(JSON.stringify(entry)) as typeof entry;
  const requirementLine = badRequirement.series.rounds[0]?.delta.lines[0];
  assert.ok(requirementLine);
  requirementLine.type = "bogus";
  assert.equal(parseReviewSeriesEntry(badRequirement), undefined);
});

test("round-trips excluded requirements and records", () => {
  const snapshot = makeSnapshot("snapshot-excluded", [
    { path: "a.lock", lines: [" head", "+changed", " tail"] },
    { path: "src/file.ts", lines: [" head", "-x  ", "+x", " tail"] },
  ]);
  const series = createReviewSeries({
    repositoryRoot: snapshot.repositoryRoot,
    sourceBranch: "main",
    targetRef: "main",
  });
  const lock = snapshot.changes[0];
  const file = snapshot.changes[1];
  assert.ok(lock && file);
  const delta = computeReviewDelta(snapshot, undefined, {
    exclusions: new Map([
      [
        changedLineKey({ fileChangeId: lock.id, side: "new", line: 2 }),
        { reason: "excluded-path", pattern: "*.lock" },
      ],
      [
        changedLineKey({ fileChangeId: file.id, side: "old", line: 2 }),
        { reason: "whitespace-only" },
      ],
      [
        changedLineKey({ fileChangeId: file.id, side: "new", line: 2 }),
        { reason: "whitespace-only" },
      ],
    ]),
  });
  const identity = getNextReviewRoundIdentity(series, snapshot);
  const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
    commentedLines: [],
    skippedSpans: [],
  });
  const submitted = appendReviewRound(
    series,
    createReviewRound(series, snapshot, delta, coverage),
  );

  const revived = parseReviewSeriesEntry(
    JSON.parse(
      JSON.stringify(serializeReviewSeriesEntry(submitted)),
    ) as unknown,
  );
  assert.deepEqual(revived, submitted);
  assert.deepEqual(
    revived.rounds[0]?.delta.lines.map((line) => line.type),
    ["excluded", "excluded", "excluded"],
  );
});

test("round-trips unit outcomes and defaults them for rounds persisted without any", () => {
  const series = makeSubmittedSeries();
  const round = series.rounds[0];
  assert.ok(round);
  const withUnits: ReviewSeries = {
    ...series,
    rounds: [
      {
        ...round,
        units: [
          {
            id: "review-unit:1" as ReviewRoundUnit["id"],
            title: "Unit",
            routine: true,
            outcome: "expanded",
            routineCandidate: false,
            commented: true,
          },
        ],
      },
    ],
  };
  const revived = parseReviewSeriesEntry(
    JSON.parse(
      JSON.stringify(serializeReviewSeriesEntry(withUnits)),
    ) as unknown,
  );
  assert.deepEqual(revived, withUnits);

  const legacy = JSON.parse(
    JSON.stringify(serializeReviewSeriesEntry(series)),
  ) as { series: { rounds: Record<string, unknown>[] } };
  for (const entry of legacy.series.rounds) delete entry.units;
  const revivedLegacy = parseReviewSeriesEntry(legacy);
  assert.deepEqual(revivedLegacy?.rounds[0]?.units, []);
});
