import assert from "node:assert/strict";
import test from "node:test";
import {
  attachReviewRoute,
  createInProgressReview,
  deleteInProgressReviewComment,
  discardInProgressReview,
  getReviewSubmissionBlockers,
  InProgressReviewError,
  markReviewUnitReviewed,
  setInProgressReviewSubmissionMode,
  submitInProgressReview,
  upsertInProgressReviewComment,
} from "../src/in-progress-review.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { createReviewSeries } from "../src/review-series.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  DiffLine,
  InProgressReview,
  ReviewRoute,
  ReviewSeries,
  ReviewSnapshot,
} from "../src/types.ts";
import { hunkId, makeSnapshot } from "./domain-fixtures.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

interface ReviewFixture {
  readonly review: InProgressReview;
  readonly route: ReviewRoute;
  readonly series: ReviewSeries;
}

function makeReviewFixture(): ReviewFixture {
  const base = makeSnapshot(
    "snapshot-progress",
    [
      { id: "h1", fingerprint: "fp1", path: "src/entry.ts" },
      { id: "h2", fingerprint: "fp2", path: "src/contract.ts" },
    ],
    { repositoryRoot: "/repo", targetRef: "main" },
  );
  const snapshot = withHunkLines(
    base,
    new Map([
      [hunkId("h1"), [{ index: 0, kind: "added", raw: "+entry", newLine: 1 }]],
      [
        hunkId("h2"),
        [{ index: 0, kind: "added", raw: "+contract", newLine: 1 }],
      ],
    ]),
  );
  const delta = computeReviewDelta(snapshot);
  const series = createReviewSeries({
    repositoryRoot: snapshot.repositoryRoot,
    sourceBranch: "feature",
    targetRef: snapshot.comparison.targetRef,
  });
  const route = validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Entry",
        whyHere: "The behavior starts here.",
        context: "entry -> contract",
        changeSummary: "Changes the entry behavior.",
        reviewFocus: ["Is the entry behavior correct?"],
        hunkIds: ["h1"],
      },
      {
        title: "Contract",
        whyHere: "The entry depends on this contract.",
        context: "entry -> contract",
        changeSummary: "Changes the contract.",
        reviewFocus: ["Is the contract compatible?"],
        hunkIds: ["h2"],
      },
    ],
    skippedHunks: [],
  });
  const review = createInProgressReview({
    series,
    snapshot,
    delta,
    timestamp: CREATED_AT,
  });
  return { review, route, series };
}

function withHunkLines(
  snapshot: ReviewSnapshot,
  linesByHunkId: ReadonlyMap<string, readonly DiffLine[]>,
): ReviewSnapshot {
  return {
    ...snapshot,
    changes: snapshot.changes.map((change) =>
      change.content.kind === "text"
        ? {
            ...change,
            content: {
              kind: "text",
              hunks: change.content.hunks.map((hunk) => ({
                ...hunk,
                lines: linesByHunkId.get(hunk.id) ?? hunk.lines,
              })),
            },
          }
        : change,
    ),
  };
}

function mutate(review: InProgressReview, timestamp: string) {
  return { expectedVersion: review.version, timestamp };
}

function readyReview(): ReviewFixture {
  const fixture = makeReviewFixture();
  return {
    ...fixture,
    review: attachReviewRoute(
      fixture.review,
      fixture.route,
      mutate(fixture.review, "2026-01-01T00:01:00.000Z"),
    ),
  };
}

test("creates a deterministic route-independent in-progress review", () => {
  const fixture = makeReviewFixture();
  const second = makeReviewFixture();

  assert.equal(fixture.review.id, second.review.id);
  assert.equal(fixture.review.lifecycle, "preparing-route");
  assert.equal(fixture.review.route, undefined);
  assert.deepEqual(fixture.review.unitProgress, []);
  assert.deepEqual(fixture.review.comments, []);
  assert.equal(fixture.review.version, 1);
  assert.equal(fixture.review.createdAt, CREATED_AT);
});

test("attaches one validated route and initializes pending unit progress", () => {
  const fixture = readyReview();

  assert.equal(fixture.review.lifecycle, "ready");
  assert.equal(fixture.review.version, 2);
  assert.deepEqual(
    fixture.review.unitProgress.map((progress) => progress.disposition),
    ["pending", "pending"],
  );
  assert.throws(
    () =>
      attachReviewRoute(
        fixture.review,
        fixture.route,
        mutate(fixture.review, "2026-01-01T00:02:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "route-already-attached"),
  );
});

test("marks known units reviewed and treats repeated confirmation as idempotent", () => {
  const fixture = readyReview();
  const unitId = fixture.route.units[0]?.id;
  assert.ok(unitId);
  const reviewed = markReviewUnitReviewed(
    fixture.review,
    unitId,
    mutate(fixture.review, "2026-01-01T00:02:00.000Z"),
  );
  const repeated = markReviewUnitReviewed(
    reviewed,
    unitId,
    mutate(reviewed, "2026-01-01T00:03:00.000Z"),
  );

  assert.equal(reviewed.unitProgress[0]?.disposition, "reviewed");
  assert.equal(repeated, reviewed);
  assert.throws(
    () =>
      markReviewUnitReviewed(
        reviewed,
        "unknown-unit" as typeof unitId,
        mutate(reviewed, "2026-01-01T00:03:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "unknown-review-unit"),
  );
});

test("rejects stale optimistic mutations", () => {
  const fixture = readyReview();
  const unitId = fixture.route.units[0]?.id;
  assert.ok(unitId);

  assert.throws(
    () =>
      markReviewUnitReviewed(fixture.review, unitId, {
        expectedVersion: fixture.review.version - 1,
        timestamp: "2026-01-01T00:02:00.000Z",
      }),
    (error: unknown) => hasCode(error, "version-conflict"),
  );
});

test("owns draft comments and submission mode outside the TUI", () => {
  const fixture = readyReview();
  const unit = fixture.route.units[0];
  assert.ok(unit);
  const withComment = upsertInProgressReviewComment(
    fixture.review,
    {
      reviewUnitId: unit.id,
      hunkId: hunkId("h1"),
      diffLineIndex: 0,
      body: "Explain this behavior.",
    },
    mutate(fixture.review, "2026-01-01T00:02:00.000Z"),
  );
  const withMode = setInProgressReviewSubmissionMode(
    withComment,
    "apply-change-requests",
    mutate(withComment, "2026-01-01T00:03:00.000Z"),
  );
  const withoutComment = deleteInProgressReviewComment(
    withMode,
    {
      reviewUnitId: unit.id,
      hunkId: hunkId("h1"),
      diffLineIndex: 0,
    },
    mutate(withMode, "2026-01-01T00:04:00.000Z"),
  );

  assert.equal(withComment.comments[0]?.body, "Explain this behavior.");
  assert.equal(withMode.submissionMode, "apply-change-requests");
  assert.deepEqual(withoutComment.comments, []);
});

test("derives submission blockers from domain state and repository state", () => {
  const fixture = readyReview();
  const current = getReviewSubmissionBlockers(
    fixture.review,
    fixture.review.snapshot.repositoryState,
  );
  const drifted = getReviewSubmissionBlockers(fixture.review, {
    ...fixture.review.snapshot.repositoryState,
    unstagedFingerprint:
      "different" as typeof fixture.review.snapshot.repositoryState.unstagedFingerprint,
  });

  assert.equal(current.lifecycle, undefined);
  assert.equal(current.routeNotAttached, false);
  assert.equal(current.pendingReviewUnitIds.length, 2);
  assert.equal(current.repositoryDrifted, false);
  assert.equal(drifted.repositoryDrifted, true);
});

test("submits only a complete current review and appends an immutable round", () => {
  const fixture = readyReview();
  const firstUnit = fixture.route.units[0];
  const secondUnit = fixture.route.units[1];
  assert.ok(firstUnit);
  assert.ok(secondUnit);
  const firstReviewed = markReviewUnitReviewed(
    fixture.review,
    firstUnit.id,
    mutate(fixture.review, "2026-01-01T00:02:00.000Z"),
  );
  assert.throws(
    () =>
      submitInProgressReview(
        firstReviewed,
        fixture.series,
        firstReviewed.snapshot.repositoryState,
        mutate(firstReviewed, "2026-01-01T00:03:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "review-incomplete"),
  );
  const complete = markReviewUnitReviewed(
    firstReviewed,
    secondUnit.id,
    mutate(firstReviewed, "2026-01-01T00:03:00.000Z"),
  );
  assert.throws(
    () =>
      submitInProgressReview(
        complete,
        fixture.series,
        {
          ...complete.snapshot.repositoryState,
          untrackedFingerprint:
            "different" as typeof complete.snapshot.repositoryState.untrackedFingerprint,
        },
        mutate(complete, "2026-01-01T00:04:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "repository-drifted"),
  );

  const submitted = submitInProgressReview(
    complete,
    fixture.series,
    complete.snapshot.repositoryState,
    mutate(complete, "2026-01-01T00:04:00.000Z"),
  );
  assert.equal(submitted.review.lifecycle, "submitted");
  assert.equal(submitted.series.rounds.length, 1);
  assert.equal(submitted.round.snapshot.id, complete.snapshot.id);
  assert.deepEqual(
    submitted.round.coverage.records.map((record) => record.disposition),
    ["reviewed-without-comment", "reviewed-without-comment"],
  );
  assert.deepEqual(fixture.series.rounds, []);
});

test("discard is explicit, clears drafts, and is terminal", () => {
  const fixture = readyReview();
  const unit = fixture.route.units[0];
  assert.ok(unit);
  const withComment = upsertInProgressReviewComment(
    fixture.review,
    {
      reviewUnitId: unit.id,
      hunkId: hunkId("h1"),
      diffLineIndex: 0,
      body: "Draft",
    },
    mutate(fixture.review, "2026-01-01T00:02:00.000Z"),
  );
  const discarded = discardInProgressReview(
    withComment,
    mutate(withComment, "2026-01-01T00:03:00.000Z"),
  );

  assert.equal(discarded.lifecycle, "discarded");
  assert.deepEqual(discarded.comments, []);
  assert.throws(
    () =>
      discardInProgressReview(
        discarded,
        mutate(discarded, "2026-01-01T00:04:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "invalid-lifecycle"),
  );
});

function hasCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof InProgressReviewError);
  assert.equal(error.code, code);
  return true;
}
