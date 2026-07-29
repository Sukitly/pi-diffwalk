import assert from "node:assert/strict";
import test from "node:test";
import {
	computeReviewCoverage,
	ReviewCoverageError,
} from "../src/review-coverage.ts";
import type { ReviewDelta } from "../src/types.ts";
import {
	fingerprint,
	hunkId,
	makeSnapshot,
	roundId,
} from "./domain-fixtures.ts";

function firstRoundDelta(snapshotId: string): ReviewDelta {
	return {
		currentSnapshotId: snapshotId as ReviewDelta["currentSnapshotId"],
		hunks: [
			{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" },
			{ type: "needs-review", hunkId: hunkId("h2"), reason: "new" },
			{ type: "needs-review", hunkId: hunkId("h3"), reason: "new" },
		],
		removedHunkFingerprints: [],
	};
}

test("returns empty coverage for an empty snapshot", () => {
	const snapshot = makeSnapshot("snapshot-empty", []);
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [],
		removedHunkFingerprints: [],
	};

	assert.deepEqual(
		computeReviewCoverage(roundId("round-1"), snapshot, delta, {
			commentedHunkIds: [],
			skippedHunks: [],
		}),
		{ snapshotId: snapshot.id, records: [] },
	);
});

test("materializes a complete coverage ledger from one batch submission", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const currentRoundId = roundId("round-1");

	const coverage = computeReviewCoverage(
		currentRoundId,
		snapshot,
		firstRoundDelta("snapshot-1"),
		{
			commentedHunkIds: [hunkId("h2")],
			skippedHunks: [{ hunkId: hunkId("h3"), reason: "Generated output" }],
		},
	);

	assert.deepEqual(coverage.records, [
		{
			hunkId: hunkId("h1"),
			fingerprint: fingerprint("f1"),
			disposition: "reviewed-without-comment",
			reviewedInRoundId: currentRoundId,
		},
		{
			hunkId: hunkId("h2"),
			fingerprint: fingerprint("f2"),
			disposition: "commented",
			commentedInRoundId: currentRoundId,
		},
		{
			hunkId: hunkId("h3"),
			fingerprint: fingerprint("f3"),
			disposition: "skipped",
			skippedInRoundId: currentRoundId,
			skipReason: "Generated output",
		},
	]);
});

test("preserves carried review provenance without requiring user interaction", () => {
	const snapshot = makeSnapshot("snapshot-2", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const originalRoundId = roundId("round-1");
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		baselineRoundId: originalRoundId,
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunkId("h1"),
				reviewedInRoundId: originalRoundId,
			},
		],
		removedHunkFingerprints: [],
	};

	const coverage = computeReviewCoverage(roundId("round-2"), snapshot, delta, {
		commentedHunkIds: [],
		skippedHunks: [],
	});

	assert.deepEqual(coverage.records, [
		{
			hunkId: hunkId("h1"),
			fingerprint: fingerprint("f1"),
			disposition: "reviewed-without-comment",
			reviewedInRoundId: originalRoundId,
		},
	]);
});

test("allows a user comment to override carried-forward coverage", () => {
	const snapshot = makeSnapshot("snapshot-2", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		baselineRoundId: roundId("round-1"),
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunkId("h1"),
				reviewedInRoundId: roundId("round-1"),
			},
		],
		removedHunkFingerprints: [],
	};
	const currentRoundId = roundId("round-2");

	const coverage = computeReviewCoverage(currentRoundId, snapshot, delta, {
		commentedHunkIds: [hunkId("h1"), hunkId("h1")],
		skippedHunks: [],
	});

	assert.equal(coverage.records[0]?.disposition, "commented");
	assert.deepEqual(coverage.records[0], {
		hunkId: hunkId("h1"),
		fingerprint: fingerprint("f1"),
		disposition: "commented",
		commentedInRoundId: currentRoundId,
	});
});

test("rejects unknown, duplicate, empty, and conflicting skip outcomes", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const delta = firstRoundDelta("snapshot-1");
	const currentRoundId = roundId("round-1");

	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, delta, {
				commentedHunkIds: [hunkId("unknown")],
				skippedHunks: [],
			}),
		/Comment references unknown hunk/,
	);
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, delta, {
				commentedHunkIds: [],
				skippedHunks: [
					{ hunkId: hunkId("h3"), reason: "one" },
					{ hunkId: hunkId("h3"), reason: "two" },
				],
			}),
		/is skipped more than once/,
	);
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, delta, {
				commentedHunkIds: [],
				skippedHunks: [{ hunkId: hunkId("h3"), reason: "   " }],
			}),
		/requires a non-empty reason/,
	);
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, delta, {
				commentedHunkIds: [hunkId("h3")],
				skippedHunks: [{ hunkId: hunkId("h3"), reason: "Generated" }],
			}),
		/cannot be both commented and skipped/,
	);
});

test("rejects mismatched snapshots, unknown skips, and carried-forward skips", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const currentRoundId = roundId("round-1");
	const wrongSnapshotDelta: ReviewDelta = {
		currentSnapshotId: makeSnapshot("other-snapshot", []).id,
		hunks: [{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" }],
		removedHunkFingerprints: [],
	};
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, wrongSnapshotDelta, {
				commentedHunkIds: [],
				skippedHunks: [],
			}),
		/Review delta references snapshot/,
	);

	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" }],
		removedHunkFingerprints: [],
	};
	assert.throws(
		() =>
			computeReviewCoverage(
				currentRoundId,
				snapshot,
				{
					...delta,
					hunks: [
						{ type: "needs-review", hunkId: hunkId("unknown"), reason: "new" },
					],
				},
				{ commentedHunkIds: [], skippedHunks: [] },
			),
		/Review delta contains unknown hunk/,
	);
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, delta, {
				commentedHunkIds: [],
				skippedHunks: [{ hunkId: hunkId("unknown"), reason: "Unknown" }],
			}),
		/Skip references unknown hunk/,
	);

	const carriedDelta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		baselineRoundId: roundId("round-0"),
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunkId("h1"),
				reviewedInRoundId: roundId("round-0"),
			},
		],
		removedHunkFingerprints: [],
	};
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, carriedDelta, {
				commentedHunkIds: [],
				skippedHunks: [{ hunkId: hunkId("h1"), reason: "Skip" }],
			}),
		/Carried-forward hunk h1 cannot be skipped/,
	);
});

test("is deterministic and does not mutate its inputs", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const delta = firstRoundDelta("snapshot-1");
	const input = {
		commentedHunkIds: [hunkId("h2")],
		skippedHunks: [{ hunkId: hunkId("h3"), reason: "Generated" }],
	};
	const snapshotBefore = structuredClone(snapshot);
	const deltaBefore = structuredClone(delta);
	const inputBefore = structuredClone(input);

	const first = computeReviewCoverage(
		roundId("round-1"),
		snapshot,
		delta,
		input,
	);
	const second = computeReviewCoverage(
		roundId("round-1"),
		snapshot,
		delta,
		input,
	);

	assert.deepEqual(second, first);
	assert.deepEqual(snapshot, snapshotBefore);
	assert.deepEqual(delta, deltaBefore);
	assert.deepEqual(input, inputBefore);
});

test("rejects a delta with missing or duplicate hunk coverage", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const currentRoundId = roundId("round-1");
	const missing: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [],
		removedHunkFingerprints: [],
	};
	const duplicate: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" },
			{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" },
		],
		removedHunkFingerprints: [],
	};

	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, missing, {
				commentedHunkIds: [],
				skippedHunks: [],
			}),
		(error: unknown) => {
			assert.ok(error instanceof ReviewCoverageError);
			assert.match(error.message, /does not cover hunk/);
			return true;
		},
	);
	assert.throws(
		() =>
			computeReviewCoverage(currentRoundId, snapshot, duplicate, {
				commentedHunkIds: [],
				skippedHunks: [],
			}),
		/contains duplicate hunk/,
	);
});
