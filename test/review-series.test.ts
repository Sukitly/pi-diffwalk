import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewCoverage } from "../src/review-coverage.ts";
import { computeReviewDelta, ReviewDeltaError } from "../src/review-delta.ts";
import {
	appendReviewRound,
	createReviewRound,
	createReviewSeries,
	getNextReviewRoundIdentity,
	ReviewSeriesError,
} from "../src/review-series.ts";
import type { ReviewCoverage, ReviewDelta, ReviewRound } from "../src/types.ts";
import {
	fingerprint,
	hunkId,
	listHunks,
	makeSnapshot,
	roundId,
	seriesId,
} from "./domain-fixtures.ts";

function createValidRoundData() {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-validation", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = computeReviewDelta(snapshot);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});
	return { series, snapshot, delta, identity, coverage };
}

test("rejects empty series identity values", () => {
	assert.throws(
		() =>
			createReviewSeries({
				repositoryRoot: " ",
				sourceBranch: "feature",
				targetRef: "main",
			}),
		/Repository root is required/,
	);
	assert.throws(
		() =>
			createReviewSeries({
				repositoryRoot: "/repo",
				sourceBranch: " ",
				targetRef: "main",
			}),
		/Source branch is required/,
	);
	assert.throws(
		() =>
			createReviewSeries({
				repositoryRoot: "/repo",
				sourceBranch: "feature",
				targetRef: " ",
			}),
		/Target ref is required/,
	);
});

test("creates deterministic series IDs from repository, source branch, and target", () => {
	const input = {
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	};

	const first = createReviewSeries(input);
	const second = createReviewSeries(input);
	const reordered = createReviewSeries({
		targetRef: input.targetRef,
		repositoryRoot: input.repositoryRoot,
		sourceBranch: input.sourceBranch,
	});
	const otherTarget = createReviewSeries({ ...input, targetRef: "develop" });

	assert.deepEqual(second, first);
	assert.equal(reordered.id, first.id);
	assert.notEqual(otherTarget.id, first.id);
	assert.deepEqual(first.rounds, []);
});

test("creates and appends sequential completed rounds", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const firstSnapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "same" },
	]);
	const firstDelta = computeReviewDelta(firstSnapshot);
	const firstIdentity = getNextReviewRoundIdentity(series, firstSnapshot);
	const firstCoverage = computeReviewCoverage(
		firstIdentity.id,
		firstSnapshot,
		firstDelta,
		{ commentedHunkIds: [], skippedHunks: [] },
	);
	const firstRound = createReviewRound(
		series,
		firstSnapshot,
		firstDelta,
		firstCoverage,
	);
	const seriesBeforeAppend = structuredClone(series);
	const afterFirst = appendReviewRound(series, firstRound);

	assert.deepEqual(
		getNextReviewRoundIdentity(series, firstSnapshot),
		firstIdentity,
	);
	assert.deepEqual(series, seriesBeforeAppend);
	assert.equal(firstRound.id, firstIdentity.id);
	assert.equal(firstRound.sequence, 1);
	assert.equal(series.rounds.length, 0);
	assert.equal(afterFirst.rounds.length, 1);

	const secondSnapshot = makeSnapshot("snapshot-2", [
		{ id: "h2", fingerprint: "same", start: 30 },
	]);
	const secondDelta = computeReviewDelta(secondSnapshot, firstRound);
	const secondIdentity = getNextReviewRoundIdentity(afterFirst, secondSnapshot);
	const secondCoverage = computeReviewCoverage(
		secondIdentity.id,
		secondSnapshot,
		secondDelta,
		{ commentedHunkIds: [], skippedHunks: [] },
	);
	const secondRound = createReviewRound(
		afterFirst,
		secondSnapshot,
		secondDelta,
		secondCoverage,
	);
	const afterSecond = appendReviewRound(afterFirst, secondRound);

	assert.equal(secondRound.sequence, 2);
	assert.equal(secondRound.delta.baselineRoundId, firstRound.id);
	assert.equal(afterSecond.rounds.length, 2);
	assert.equal(afterSecond.rounds[1]?.id, secondRound.id);
	assert.equal(
		secondCoverage.records[0]?.disposition,
		"reviewed-without-comment",
	);
	const secondRecord = secondCoverage.records[0];
	assert.ok(secondRecord?.disposition === "reviewed-without-comment");
	const firstRecord = firstCoverage.records[0];
	assert.ok(firstRecord?.disposition === "reviewed-without-comment");
	assert.equal(secondRecord.reviewedInRoundId, firstRecord.reviewedInRoundId);
});

test("rejects snapshots and deltas that do not belong to the series", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const wrongTarget = makeSnapshot(
		"snapshot-1",
		[{ id: "h1", fingerprint: "f1" }],
		{ targetRef: "develop" },
	);
	assert.throws(
		() => getNextReviewRoundIdentity(series, wrongTarget),
		/Snapshot target develop does not match series target main/,
	);
	const wrongRepository = makeSnapshot(
		"snapshot-wrong-repository",
		[{ id: "h1", fingerprint: "f1" }],
		{ repositoryRoot: "/other" },
	);
	assert.throws(
		() => getNextReviewRoundIdentity(series, wrongRepository),
		/Snapshot repository \/other does not match series repository \/repo/,
	);

	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const delta: ReviewDelta = {
		...computeReviewDelta(snapshot),
		baselineRoundId: roundId("unexpected-baseline"),
	};
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});
	assert.throws(
		() => createReviewRound(series, snapshot, delta, coverage),
		/does not match expected baseline/,
	);
});

test("rejects malformed round snapshot references and hunk coverage", () => {
	const { series, snapshot, delta, identity, coverage } =
		createValidRoundData();
	const otherSnapshotId = makeSnapshot("other-snapshot", []).id;

	assert.throws(
		() =>
			createReviewRound(
				series,
				snapshot,
				{ ...delta, currentSnapshotId: otherSnapshotId },
				coverage,
			),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /Review delta references snapshot/);
			return true;
		},
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				...coverage,
				snapshotId: otherSnapshotId,
			}),
		/Review coverage references snapshot/,
	);
	assert.throws(
		() =>
			createReviewRound(
				series,
				snapshot,
				{
					...delta,
					hunks: [
						{ type: "needs-review", hunkId: hunkId("unknown"), reason: "new" },
					],
				},
				coverage,
			),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /Review delta contains unknown hunk/);
			return true;
		},
	);
	assert.throws(
		() =>
			createReviewRound(
				series,
				snapshot,
				{ ...delta, hunks: [...delta.hunks, ...delta.hunks] },
				coverage,
			),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /Review delta contains duplicate hunk/);
			return true;
		},
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, { ...delta, hunks: [] }, coverage),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /does not cover snapshot hunk/);
			return true;
		},
	);

	const validRecord = coverage.records[0];
	assert.ok(validRecord);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				...coverage,
				records: [{ ...validRecord, hunkId: hunkId("unknown") }],
			}),
		/Review coverage contains unknown hunk/,
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				...coverage,
				records: [validRecord, validRecord],
			}),
		/Review coverage contains duplicate hunk/,
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, { ...coverage, records: [] }),
		/Review coverage does not cover hunk/,
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				...coverage,
				records: [
					{
						hunkId: hunkId("h1"),
						fingerprint: fingerprint("f1"),
						disposition: "skipped",
						skippedInRoundId: identity.id,
						skipReason: " ",
					},
				],
			}),
		/requires a non-empty reason/,
	);
});

test("accepts valid commented and skipped disposition provenance", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-dispositions", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
	]);
	const delta = computeReviewDelta(snapshot);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [hunkId("h1")],
		skippedHunks: [{ hunkId: hunkId("h2"), reason: "Generated" }],
	});

	const round = createReviewRound(series, snapshot, delta, coverage);

	assert.equal(round.coverage.records[0]?.disposition, "commented");
	assert.equal(round.coverage.records[1]?.disposition, "skipped");
});

test("rejects invalid disposition provenance combinations", () => {
	const { series, snapshot, delta, identity } = createValidRoundData();
	const base = { hunkId: hunkId("h1"), fingerprint: fingerprint("f1") };

	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				snapshotId: snapshot.id,
				records: [
					{
						...base,
						disposition: "commented",
						commentedInRoundId: roundId("wrong"),
					},
				],
			}),
		/must reference current round/,
	);
	assert.throws(
		() =>
			createReviewRound(series, snapshot, delta, {
				snapshotId: snapshot.id,
				records: [
					{
						...base,
						disposition: "skipped",
						skippedInRoundId: roundId("wrong"),
						skipReason: "Skip",
					},
				],
			}),
		/must reference current round/,
	);

	const carriedDelta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunkId("h1"),
				reviewedInRoundId: identity.id,
			},
		],
		removedHunkFingerprints: [],
	};
	assert.throws(
		() =>
			createReviewRound(series, snapshot, carriedDelta, {
				snapshotId: snapshot.id,
				records: [
					{
						...base,
						disposition: "skipped",
						skippedInRoundId: identity.id,
						skipReason: "Skip",
					},
				],
			}),
		/Carried-forward hunk h1 cannot be skipped/,
	);
});

test("rejects invalid round IDs, sequences, and series IDs when appending", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = computeReviewDelta(snapshot);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});
	const valid = createReviewRound(series, snapshot, delta, coverage);

	const wrongId: ReviewRound = { ...valid, id: roundId("wrong") };
	assert.throws(
		() => appendReviewRound(series, wrongId),
		/does not match expected ID/,
	);
	const wrongSeries: ReviewRound = { ...valid, seriesId: seriesId("wrong") };
	assert.throws(
		() => appendReviewRound(series, wrongSeries),
		/belongs to series/,
	);
	const wrongSequence: ReviewRound = { ...valid, sequence: 2 };
	assert.throws(
		() => appendReviewRound(series, wrongSequence),
		/has sequence 2, expected 1/,
	);
});

test("rejects carried coverage that references a round outside the series", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const hunk = listHunks(snapshot)[0];
	assert.ok(hunk);
	const unknownRoundId = roundId("unknown-round");
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunk.id,
				reviewedInRoundId: unknownRoundId,
			},
		],
		removedHunkFingerprints: [],
	};
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});

	assert.throws(
		() => createReviewRound(series, snapshot, delta, coverage),
		/references unknown prior round unknown-round/,
	);
});

test("rejects malformed existing series history", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = computeReviewDelta(snapshot);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const coverage = computeReviewCoverage(identity.id, snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});
	const round = createReviewRound(series, snapshot, delta, coverage);
	const validSeries = appendReviewRound(series, round);
	const nextSnapshot = makeSnapshot("snapshot-2", []);

	const wrongSeriesRound: ReviewRound = {
		...round,
		seriesId: seriesId("wrong"),
	};
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [wrongSeriesRound] },
				nextSnapshot,
			),
		/belongs to series/,
	);
	const wrongSequenceRound: ReviewRound = { ...round, sequence: 2 };
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [wrongSequenceRound] },
				nextSnapshot,
			),
		/has sequence 2, expected 1/,
	);
	const duplicateRound: ReviewRound = { ...round, sequence: 2 };
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [round, duplicateRound] },
				nextSnapshot,
			),
		/contains duplicate round ID/,
	);
	const wrongIdRound: ReviewRound = { ...round, id: roundId("wrong-id") };
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [wrongIdRound] },
				nextSnapshot,
			),
		/does not match expected ID/,
	);

	const wrongBaselineRound: ReviewRound = {
		...round,
		delta: { ...round.delta, baselineRoundId: roundId("unexpected") },
	};
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [wrongBaselineRound] },
				nextSnapshot,
			),
		/does not match expected baseline/,
	);

	const record = coverage.records[0];
	assert.ok(record);
	const wrongCoverageRound: ReviewRound = {
		...round,
		coverage: {
			...coverage,
			records: [{ ...record, fingerprint: fingerprint("wrong") }],
		},
	};
	assert.throws(
		() =>
			getNextReviewRoundIdentity(
				{ ...validSeries, rounds: [wrongCoverageRound] },
				nextSnapshot,
			),
		/does not match hunk/,
	);
});

test("rejects coverage with incorrect disposition provenance", () => {
	const series = createReviewSeries({
		repositoryRoot: "/repo",
		sourceBranch: "feature",
		targetRef: "main",
	});
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = computeReviewDelta(snapshot);
	const identity = getNextReviewRoundIdentity(series, snapshot);
	const hunk = listHunks(snapshot)[0];
	assert.ok(hunk);
	const coverage: ReviewCoverage = {
		snapshotId: snapshot.id,
		records: [
			{
				hunkId: hunk.id,
				fingerprint: hunk.fingerprint,
				disposition: "reviewed-without-comment",
				reviewedInRoundId: roundId("wrong-round"),
			},
		],
	};

	assert.throws(
		() => createReviewRound(series, snapshot, delta, coverage),
		(error: unknown) => {
			assert.ok(error instanceof ReviewSeriesError);
			assert.match(error.message, /expected/);
			return true;
		},
	);
	assert.notEqual(identity.id, roundId("wrong-round"));
});
