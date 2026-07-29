import assert from "node:assert/strict";
import test from "node:test";
import {
	assertReviewDeltaMatchesSnapshot,
	computeReviewDelta,
	isNeedsReviewReasonSkippable,
	ReviewDeltaError,
} from "../src/review-delta.ts";
import type { DiffHunk, HunkReviewRecord, ReviewDelta } from "../src/types.ts";
import {
	fingerprint,
	hunkId,
	listHunks,
	makeRound,
	makeSnapshot,
	roundId,
} from "./domain-fixtures.ts";

function reviewed(hunk: DiffHunk, reviewedIn: string): HunkReviewRecord {
	return {
		hunkId: hunk.id,
		fingerprint: hunk.fingerprint,
		disposition: "reviewed-without-comment",
		reviewedInRoundId: roundId(reviewedIn),
	};
}

function commented(hunk: DiffHunk, commentedIn: string): HunkReviewRecord {
	return {
		hunkId: hunk.id,
		fingerprint: hunk.fingerprint,
		disposition: "commented",
		commentedInRoundId: roundId(commentedIn),
	};
}

function skipped(hunk: DiffHunk, skippedIn: string): HunkReviewRecord {
	return {
		hunkId: hunk.id,
		fingerprint: hunk.fingerprint,
		disposition: "skipped",
		skippedInRoundId: roundId(skippedIn),
		skipReason: "Generated file",
	};
}

test("returns an empty first-round delta for an empty snapshot", () => {
	const snapshot = makeSnapshot("snapshot-empty", []);

	assert.deepEqual(computeReviewDelta(snapshot), {
		currentSnapshotId: snapshot.id,
		hunks: [],
		removedHunkFingerprints: [],
	});
});

test("marks every first-round hunk as new", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/other.ts" },
	]);

	const delta = computeReviewDelta(snapshot);

	assert.equal(delta.baselineRoundId, undefined);
	assert.deepEqual(delta.hunks, [
		{ type: "needs-review", hunkId: hunkId("h1"), reason: "new" },
		{ type: "needs-review", hunkId: hunkId("h2"), reason: "new" },
	]);
	assert.deepEqual(delta.removedHunkFingerprints, []);
});

test("asserts that a review delta covers its snapshot exactly once", () => {
	const snapshot = makeSnapshot("snapshot-1", [
		{ id: "h1", fingerprint: "f1" },
		{ id: "h2", fingerprint: "f2", path: "src/two.ts" },
	]);
	const valid = computeReviewDelta(snapshot);
	const snapshotBefore = structuredClone(snapshot);
	const validBefore = structuredClone(valid);
	const firstRequirement = valid.hunks[0];
	assert.ok(firstRequirement);
	assert.doesNotThrow(() => assertReviewDeltaMatchesSnapshot(snapshot, valid));
	assert.deepEqual(snapshot, snapshotBefore);
	assert.deepEqual(valid, validBefore);

	const invalidDeltas: readonly {
		readonly delta: ReviewDelta;
		readonly message: RegExp;
	}[] = [
		{
			delta: {
				...valid,
				currentSnapshotId: makeSnapshot("other-snapshot", []).id,
			},
			message: /references snapshot/,
		},
		{
			delta: {
				...valid,
				hunks: [
					{ type: "needs-review", hunkId: hunkId("unknown"), reason: "new" },
				],
			},
			message: /contains unknown hunk/,
		},
		{
			delta: { ...valid, hunks: [firstRequirement, firstRequirement] },
			message: /contains duplicate hunk/,
		},
		{
			delta: { ...valid, hunks: [firstRequirement] },
			message: /does not cover snapshot hunk h2/,
		},
	];
	for (const invalid of invalidDeltas) {
		assert.throws(
			() => assertReviewDeltaMatchesSnapshot(snapshot, invalid.delta),
			(error: unknown) => {
				assert.ok(error instanceof ReviewDeltaError);
				assert.match(error.message, invalid.message);
				return true;
			},
		);
	}
});

test("defines skip eligibility for every needs-review reason", () => {
	assert.equal(isNeedsReviewReasonSkippable("unresolved-comment"), false);
	assert.equal(isNeedsReviewReasonSkippable("new"), true);
	assert.equal(isNeedsReviewReasonSkippable("changed"), true);
	assert.equal(isNeedsReviewReasonSkippable("previously-skipped"), true);
	assert.equal(isNeedsReviewReasonSkippable("ambiguous-match"), true);
});

test("carries an unchanged reviewed hunk with its original review provenance", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "same", start: 10 },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-2",
		snapshot: baselineSnapshot,
		records: [reviewed(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-hunk", fingerprint: "same", start: 50 },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(delta.hunks, [
		{
			type: "carried-forward",
			hunkId: hunkId("current-hunk"),
			reviewedInRoundId: roundId("round-1"),
		},
	]);
	assert.deepEqual(delta.removedHunkFingerprints, []);
});

test("requires unchanged commented and skipped hunks to be reviewed again", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "commented-old", fingerprint: "commented-fp" },
		{ id: "skipped-old", fingerprint: "skipped-fp", path: "src/skipped.ts" },
	]);
	const [commentedHunk, skippedHunk] = listHunks(baselineSnapshot);
	assert.ok(commentedHunk);
	assert.ok(skippedHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [
			commented(commentedHunk, "round-1"),
			skipped(skippedHunk, "round-1"),
		],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "commented-current", fingerprint: "commented-fp" },
		{
			id: "skipped-current",
			fingerprint: "skipped-fp",
			path: "src/skipped.ts",
		},
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(delta.hunks, [
		{
			type: "needs-review",
			hunkId: hunkId("commented-current"),
			reason: "unresolved-comment",
			previousFingerprint: fingerprint("commented-fp"),
		},
		{
			type: "needs-review",
			hunkId: hunkId("skipped-current"),
			reason: "previously-skipped",
			previousFingerprint: fingerprint("skipped-fp"),
		},
	]);
});

test("links a uniquely overlapping changed hunk to its previous fingerprint", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp", start: 10, count: 5 },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [reviewed(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "changed-hunk", fingerprint: "new-fp", start: 12, count: 2 },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(delta.hunks, [
		{
			type: "needs-review",
			hunkId: hunkId("changed-hunk"),
			reason: "changed",
			previousFingerprint: fingerprint("old-fp"),
		},
	]);
	assert.deepEqual(delta.removedHunkFingerprints, []);
});

test("preserves unresolved-comment priority when a commented hunk changes", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp", start: 10, count: 5 },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [commented(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "changed-hunk", fingerprint: "new-fp", start: 11, count: 2 },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.equal(delta.hunks[0]?.type, "needs-review");
	assert.deepEqual(delta.hunks[0], {
		type: "needs-review",
		hunkId: hunkId("changed-hunk"),
		reason: "unresolved-comment",
		previousFingerprint: fingerprint("old-fp"),
	});
});

test("preserves previously-skipped priority when a skipped hunk changes", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp", start: 10, count: 5 },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [skipped(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "changed-hunk", fingerprint: "new-fp", start: 11, count: 2 },
	]);

	assert.deepEqual(computeReviewDelta(current, baseline).hunks, [
		{
			type: "needs-review",
			hunkId: hunkId("changed-hunk"),
			reason: "previously-skipped",
			previousFingerprint: fingerprint("old-fp"),
		},
	]);
});

test("classifies unrelated current hunks as new and old hunks as removed", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "removed-hunk", fingerprint: "removed-fp", path: "src/old.ts" },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [reviewed(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "new-hunk", fingerprint: "new-fp", path: "src/new.ts" },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(delta.hunks, [
		{ type: "needs-review", hunkId: hunkId("new-hunk"), reason: "new" },
	]);
	assert.deepEqual(delta.removedHunkFingerprints, [fingerprint("removed-fp")]);
});

test("marks every baseline hunk as removed when the current snapshot is empty", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-1", fingerprint: "old-fp-1" },
		{ id: "old-2", fingerprint: "old-fp-2", path: "src/other.ts" },
	]);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: listHunks(baselineSnapshot).map((hunk) =>
			reviewed(hunk, "round-1"),
		),
	});
	const current = makeSnapshot("snapshot-2", []);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(delta.hunks, []);
	assert.deepEqual(delta.removedHunkFingerprints, [
		fingerprint("old-fp-1"),
		fingerprint("old-fp-2"),
	]);
});

test("treats changed hunk splits and merges as ambiguous without reporting removals", () => {
	const splitBaselineSnapshot = makeSnapshot("split-baseline", [
		{ id: "old", fingerprint: "old", start: 10, count: 10 },
	]);
	const splitBaselineHunk = listHunks(splitBaselineSnapshot)[0];
	assert.ok(splitBaselineHunk);
	const splitBaseline = makeRound({
		id: "split-round",
		snapshot: splitBaselineSnapshot,
		records: [reviewed(splitBaselineHunk, "split-round")],
	});
	const splitCurrent = makeSnapshot("split-current", [
		{ id: "split-1", fingerprint: "split-fp-1", start: 10, count: 4 },
		{ id: "split-2", fingerprint: "split-fp-2", start: 15, count: 4 },
	]);

	const splitDelta = computeReviewDelta(splitCurrent, splitBaseline);
	assert.deepEqual(
		splitDelta.hunks.map(
			(requirement) =>
				requirement.type === "needs-review" && requirement.reason,
		),
		["ambiguous-match", "ambiguous-match"],
	);
	assert.deepEqual(splitDelta.removedHunkFingerprints, []);

	const mergeBaselineSnapshot = makeSnapshot("merge-baseline", [
		{ id: "old-1", fingerprint: "old-fp-1", start: 10, count: 4 },
		{ id: "old-2", fingerprint: "old-fp-2", start: 15, count: 4 },
	]);
	const mergeBaseline = makeRound({
		id: "merge-round",
		snapshot: mergeBaselineSnapshot,
		records: listHunks(mergeBaselineSnapshot).map((hunk) =>
			reviewed(hunk, "merge-round"),
		),
	});
	const mergeCurrent = makeSnapshot("merge-current", [
		{ id: "merged", fingerprint: "merged-fp", start: 10, count: 10 },
	]);

	const mergeDelta = computeReviewDelta(mergeCurrent, mergeBaseline);
	assert.equal(mergeDelta.hunks[0]?.type, "needs-review");
	assert.equal(
		mergeDelta.hunks[0]?.type === "needs-review"
			? mergeDelta.hunks[0].reason
			: undefined,
		"ambiguous-match",
	);
	assert.deepEqual(mergeDelta.removedHunkFingerprints, []);
});

test("requires duplicate exact fingerprints to be reviewed as ambiguous", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-1", fingerprint: "duplicate", start: 1 },
		{ id: "old-2", fingerprint: "duplicate", start: 20 },
	]);
	const baselineHunks = listHunks(baselineSnapshot);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: baselineHunks.map((hunk) => reviewed(hunk, "round-1")),
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-1", fingerprint: "duplicate", start: 1 },
		{ id: "current-2", fingerprint: "duplicate", start: 20 },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(
		delta.hunks.map(({ type, ...requirement }) => ({ type, ...requirement })),
		[
			{
				type: "needs-review",
				hunkId: hunkId("current-1"),
				reason: "ambiguous-match",
				previousFingerprint: fingerprint("duplicate"),
			},
			{
				type: "needs-review",
				hunkId: hunkId("current-2"),
				reason: "ambiguous-match",
				previousFingerprint: fingerprint("duplicate"),
			},
		],
	);
	assert.deepEqual(delta.removedHunkFingerprints, []);
});

test("preserves duplicate fingerprint multiplicity when copies are removed", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-1", fingerprint: "duplicate", start: 1 },
		{ id: "old-2", fingerprint: "duplicate", start: 20 },
		{ id: "old-3", fingerprint: "duplicate", start: 40 },
	]);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: listHunks(baselineSnapshot).map((hunk) =>
			reviewed(hunk, "round-1"),
		),
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-1", fingerprint: "duplicate", start: 1 },
		{ id: "current-2", fingerprint: "duplicate", start: 20 },
	]);

	const delta = computeReviewDelta(current, baseline);

	assert.deepEqual(
		delta.hunks.map(
			(requirement) =>
				requirement.type === "needs-review" && requirement.reason,
		),
		["ambiguous-match", "ambiguous-match"],
	);
	assert.deepEqual(delta.removedHunkFingerprints, [fingerprint("duplicate")]);
});

test("rejects corrupt baseline delta and coverage records", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp" },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const validRecord = reviewed(baselineHunk, "round-1");
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-hunk", fingerprint: "old-fp" },
	]);

	const validBaseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [validRecord],
	});
	const wrongDeltaSnapshot = {
		...validBaseline,
		delta: { ...validBaseline.delta, currentSnapshotId: current.id },
	};
	assert.throws(
		() => computeReviewDelta(current, wrongDeltaSnapshot),
		/delta references snapshot/,
	);

	const wrongCoverageSnapshot = {
		...validBaseline,
		coverage: { ...validBaseline.coverage, snapshotId: current.id },
	};
	assert.throws(
		() => computeReviewDelta(current, wrongCoverageSnapshot),
		/coverage references snapshot/,
	);

	const duplicateCoverage = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [validRecord, validRecord],
	});
	assert.throws(
		() => computeReviewDelta(current, duplicateCoverage),
		/duplicate coverage/,
	);

	const unknownCoverage = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [validRecord, { ...validRecord, hunkId: hunkId("unknown") }],
	});
	assert.throws(
		() => computeReviewDelta(current, unknownCoverage),
		/unknown hunk/,
	);

	const wrongFingerprint = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [{ ...validRecord, fingerprint: fingerprint("wrong") }],
	});
	assert.throws(
		() => computeReviewDelta(current, wrongFingerprint),
		/does not match hunk/,
	);
});

test("is deterministic and does not mutate snapshots or baseline rounds", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp", start: 10, count: 3 },
	]);
	const baselineHunk = listHunks(baselineSnapshot)[0];
	assert.ok(baselineHunk);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [reviewed(baselineHunk, "round-1")],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-hunk", fingerprint: "new-fp", start: 11, count: 2 },
	]);
	const baselineBefore = structuredClone(baseline);
	const currentBefore = structuredClone(current);

	const first = computeReviewDelta(current, baseline);
	const second = computeReviewDelta(current, baseline);

	assert.deepEqual(second, first);
	assert.deepEqual(baseline, baselineBefore);
	assert.deepEqual(current, currentBefore);
});

test("rejects incomplete baseline coverage", () => {
	const baselineSnapshot = makeSnapshot("snapshot-1", [
		{ id: "old-hunk", fingerprint: "old-fp" },
	]);
	const baseline = makeRound({
		id: "round-1",
		snapshot: baselineSnapshot,
		records: [],
	});
	const current = makeSnapshot("snapshot-2", [
		{ id: "current-hunk", fingerprint: "old-fp" },
	]);

	assert.throws(
		() => computeReviewDelta(current, baseline),
		(error: unknown) => {
			assert.ok(error instanceof ReviewDeltaError);
			assert.match(error.message, /has no coverage/);
			return true;
		},
	);
});
