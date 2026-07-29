import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { ReviewDeltaError } from "../src/review-delta.ts";
import {
	ReviewRouteValidationError,
	type ReviewRouteValidationIssueCode,
	validateReviewRoute,
} from "../src/route-validation.ts";
import {
	type ReviewDelta,
	type ReviewRouteCandidate,
	ReviewRouteCandidateSchema,
} from "../src/types.ts";
import { hunkId, makeSnapshot, roundId } from "./domain-fixtures.ts";

type CandidateUnit = ReviewRouteCandidate["units"][number];

function makeUnit(
	hunkIds: readonly string[],
	overrides: Partial<CandidateUnit> = {},
): CandidateUnit {
	return {
		title: "Core behavior",
		whyHere: "This establishes the behavior used by later units.",
		context: "entryPoint -> calculate -> result",
		changeSummary: "The calculation now preserves review provenance.",
		reviewFocus: ["Does the calculation preserve the required invariant?"],
		hunkIds: [...hunkIds],
		...overrides,
	};
}

function makeNeedsReviewDelta(
	snapshotId: ReviewDelta["currentSnapshotId"],
	hunkIds: readonly string[],
): ReviewDelta {
	return {
		currentSnapshotId: snapshotId,
		hunks: hunkIds.map((id) => ({
			type: "needs-review",
			hunkId: hunkId(id),
			reason: "new",
		})),
		removedHunkFingerprints: [],
	};
}

function captureRouteError(
	operation: () => unknown,
): ReviewRouteValidationError {
	let caught: unknown;
	try {
		operation();
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof ReviewRouteValidationError);
	return caught;
}

function assertIssueCodes(
	error: ReviewRouteValidationError,
	expected: readonly ReviewRouteValidationIssueCode[],
): void {
	assert.deepEqual(
		error.issues.map((issue) => issue.code),
		expected,
	);
}

test("exports an agent schema that accepts explanatory routes and rejects patch content", () => {
	const candidate = {
		snapshotId: "snapshot-1",
		units: [makeUnit(["h1"])],
		skippedHunks: [],
	};
	assert.equal(Check(ReviewRouteCandidateSchema, candidate), true);
	assert.equal(
		Check(ReviewRouteCandidateSchema, {
			...candidate,
			units: [{ ...candidate.units[0], diff: "+ model-generated patch" }],
		}),
		false,
	);
});

test("validates ordered units and assigns deterministic unit IDs", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{ type: "needs-review", hunkId: hunkId("h1"), reason: "changed" },
			{
				type: "carried-forward",
				hunkId: hunkId("h2"),
				reviewedInRoundId: roundId("round-1"),
			},
			{ type: "needs-review", hunkId: hunkId("h3"), reason: "new" },
		],
		removedHunkFingerprints: [],
	};
	const candidate: ReviewRouteCandidate = {
		snapshotId: snapshot.id,
		units: [
			makeUnit(["h3"], { title: "Tests" }),
			makeUnit(["h1"], { title: "Implementation" }),
		],
		skippedHunks: [],
	};
	const snapshotBefore = structuredClone(snapshot);
	const deltaBefore = structuredClone(delta);
	const candidateBefore = structuredClone(candidate);

	const first = validateReviewRoute(snapshot, delta, candidate);
	const second = validateReviewRoute(snapshot, delta, candidate);
	const commentaryChanged = validateReviewRoute(snapshot, delta, {
		...candidate,
		units: candidate.units.map((unit) => ({
			...unit,
			changeSummary: `Updated: ${unit.changeSummary}`,
		})),
	});

	assert.deepEqual(second, first);
	assert.deepEqual(
		first.units.map((unit) => unit.hunkIds),
		[[hunkId("h3")], [hunkId("h1")]],
	);
	assert.match(first.units[0]?.id ?? "", /^review-unit:[0-9a-f]{64}$/);
	assert.notEqual(first.units[0]?.id, first.units[1]?.id);
	assert.deepEqual(
		commentaryChanged.units.map((unit) => unit.id),
		first.units.map((unit) => unit.id),
	);
	assert.deepEqual(snapshot, snapshotBefore);
	assert.deepEqual(delta, deltaBefore);
	assert.deepEqual(candidate, candidateBefore);
});

test("accepts an explicit skip while preserving route and skip order", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const delta = makeNeedsReviewDelta(snapshot.id, ["h1", "h2", "h3"]);
	const route = validateReviewRoute(snapshot, delta, {
		snapshotId: snapshot.id,
		units: [makeUnit(["h2", "h1"])],
		skippedHunks: [{ hunkId: "h3", reason: "Generated fixture" }],
	});

	assert.deepEqual(route.units[0]?.hunkIds, [hunkId("h2"), hunkId("h1")]);
	assert.deepEqual(route.skippedHunks, [
		{ hunkId: hunkId("h3"), reason: "Generated fixture" },
	]);
});

test("accepts an empty planned route when no hunk requires review", () => {
	const emptySnapshot = makeSnapshot("snapshot-empty", []);
	assert.deepEqual(
		validateReviewRoute(
			emptySnapshot,
			makeNeedsReviewDelta(emptySnapshot.id, []),
			{ snapshotId: emptySnapshot.id, units: [], skippedHunks: [] },
		),
		{
			snapshotId: emptySnapshot.id,
			units: [],
			skippedHunks: [],
		},
	);

	const carriedSnapshot = makeSnapshot("snapshot-carried", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const carriedDelta: ReviewDelta = {
		currentSnapshotId: carriedSnapshot.id,
		hunks: [
			{
				type: "carried-forward",
				hunkId: hunkId("h1"),
				reviewedInRoundId: roundId("round-1"),
			},
		],
		removedHunkFingerprints: [],
	};
	assert.deepEqual(
		validateReviewRoute(carriedSnapshot, carriedDelta, {
			snapshotId: carriedSnapshot.id,
			units: [],
			skippedHunks: [],
		}),
		{ snapshotId: carriedSnapshot.id, units: [], skippedHunks: [] },
	);
});

test("rejects unknown and carried-forward hunk references", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
	]);
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" },
			{
				type: "carried-forward",
				hunkId: hunkId("h2"),
				reviewedInRoundId: roundId("round-1"),
			},
		],
		removedHunkFingerprints: [],
	};
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: snapshot.id,
			units: [makeUnit(["h1", "h2"])],
			skippedHunks: [{ hunkId: "unknown", reason: "Not relevant" }],
		}),
	);

	assertIssueCodes(error, ["carried-forward-reference", "unknown-hunk"]);
	assert.match(error.message, /carried-forward hunk h2/);
	assert.match(error.message, /unknown hunk unknown/);
});

test("rejects duplicate, conflicting, and missing hunk coverage", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
		{ id: "h3", fingerprint: "f3", path: "src/three.ts" },
	]);
	const delta = makeNeedsReviewDelta(snapshot.id, ["h1", "h2", "h3"]);
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: snapshot.id,
			units: [makeUnit(["h1", "h1"]), makeUnit(["h3"])],
			skippedHunks: [{ hunkId: "h1", reason: "Conflict" }],
		}),
	);

	assertIssueCodes(error, ["duplicate-hunk", "duplicate-hunk", "missing-hunk"]);
	assert.match(error.message, /does not cover required hunk h2/);
});

test("rejects routes that skip every hunk requiring review", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = makeNeedsReviewDelta(snapshot.id, ["h1"]);
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: snapshot.id,
			units: [],
			skippedHunks: [{ hunkId: "h1", reason: "Generated" }],
		}),
	);

	assertIssueCodes(error, ["missing-review-unit"]);
});

test("aggregates blank metadata, empty unit, and empty skip reason issues", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
	]);
	const delta = makeNeedsReviewDelta(snapshot.id, ["h1", "h2"]);
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: "wrong-snapshot",
			units: [
				makeUnit([], {
					title: " ",
					whyHere: "",
					context: "\t",
					changeSummary: " ",
					reviewFocus: [],
				}),
				makeUnit(["h1"], { reviewFocus: [" "] }),
			],
			skippedHunks: [{ hunkId: "h2", reason: " " }],
		}),
	);

	assertIssueCodes(error, [
		"snapshot-mismatch",
		"empty-field",
		"empty-field",
		"empty-field",
		"empty-field",
		"empty-field",
		"empty-unit",
		"empty-field",
		"empty-skip-reason",
	]);
});

test("rejects skipping a hunk with an unresolved comment", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
	]);
	const delta: ReviewDelta = {
		currentSnapshotId: snapshot.id,
		hunks: [
			{
				type: "needs-review",
				hunkId: hunkId("h1"),
				reason: "unresolved-comment",
			},
			{ type: "needs-review", hunkId: hunkId("h2"), reason: "new" },
		],
		removedHunkFingerprints: [],
	};
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: snapshot.id,
			units: [makeUnit(["h2"])],
			skippedHunks: [{ hunkId: "h1", reason: "Agent skip" }],
		}),
	);

	assertIssueCodes(error, ["unresolved-comment-skip"]);
});

test("does not add missing-review-unit when a submitted unit has an invalid hunk", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = makeNeedsReviewDelta(snapshot.id, ["h1"]);
	const error = captureRouteError(() =>
		validateReviewRoute(snapshot, delta, {
			snapshotId: snapshot.id,
			units: [makeUnit(["unknown"])],
			skippedHunks: [{ hunkId: "h1", reason: "Generated" }],
		}),
	);

	assertIssueCodes(error, ["unknown-hunk"]);
});

test("propagates ReviewDeltaError before validating the candidate route", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
	]);
	const delta = {
		...makeNeedsReviewDelta(snapshot.id, ["h1"]),
		currentSnapshotId: makeSnapshot("other", []).id,
	};

	assert.throws(
		() =>
			validateReviewRoute(snapshot, delta, {
				snapshotId: snapshot.id,
				units: [makeUnit(["h1"])],
				skippedHunks: [],
			}),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /Review delta references snapshot/);
			return true;
		},
	);
});
