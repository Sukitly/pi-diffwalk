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
import type { ReviewSeries } from "../../src/review/types.ts";
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
