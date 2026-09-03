import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
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
} from "../../src/review/in-progress.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import { createReviewSeries } from "../../src/review/series.ts";
import type {
  InProgressReview,
  ReviewRoute,
  ReviewSeries,
} from "../../src/review/types.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

interface ReviewFixture {
  readonly review: InProgressReview;
  readonly route: ReviewRoute;
  readonly series: ReviewSeries;
}

function makeReviewFixture(): ReviewFixture {
  const snapshot = makeSnapshot(
    "snapshot-progress",
    [
      { path: "src/entry.ts", lines: [" head", "+entry", " tail"] },
      { path: "src/contract.ts", lines: [" head", "+contract", " tail"] },
    ],
    { repositoryRoot: "/repo", targetRef: "main" },
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
        reviewFocus: [{ question: "Is the entry behavior correct?" }],
        spans: [span("src/entry.ts", { new: [2, 2] })],
      },
      {
        title: "Contract",
        whyHere: "The entry depends on this contract.",
        context: "entry -> contract",
        changeSummary: "Changes the contract.",
        reviewFocus: [{ question: "Is the contract compatible?" }],
        spans: [span("src/contract.ts", { new: [2, 2] })],
      },
    ],
    skippedSpans: [],
  });
  const review = createInProgressReview({
    series,
    snapshot,
    delta,
    timestamp: CREATED_AT,
  });
  return { review, route, series };
}

function anchor(path: string, line: number) {
  return {
    fileChangeId: fileChangeId("modified", path),
    side: "new" as const,
    line,
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

test("rejects a blank mutation timestamp with an input-specific code", () => {
  const fixture = readyReview();
  const unitId = fixture.route.units[0]?.id;
  assert.ok(unitId);

  assert.throws(
    () =>
      markReviewUnitReviewed(fixture.review, unitId, {
        expectedVersion: fixture.review.version,
        timestamp: " ",
      }),
    (error: unknown) => hasCode(error, "invalid-timestamp"),
  );
});

test("rejects submission into a foreign series with a series-mismatch code", () => {
  const fixture = readyReview();
  let review = fixture.review;
  for (const unit of fixture.route.units) {
    review = markReviewUnitReviewed(
      review,
      unit.id,
      mutate(review, "2026-01-01T00:02:00.000Z"),
    );
  }
  const foreignSeries = createReviewSeries({
    repositoryRoot: review.snapshot.repositoryRoot,
    sourceBranch: "another-branch",
    targetRef: review.snapshot.comparison.targetRef,
  });

  assert.throws(
    () =>
      submitInProgressReview(
        review,
        foreignSeries,
        review.snapshot.repositoryState,
        mutate(review, "2026-01-01T00:03:00.000Z"),
      ),
    (error: unknown) => hasCode(error, "series-mismatch"),
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
      ...anchor("src/entry.ts", 2),
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
      ...anchor("src/entry.ts", 2),
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

  assert.equal(current.blockingLifecycle, undefined);
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
    submitted.round.coverage.files.flatMap((file) =>
      file.lines.map((record) => record.disposition),
    ),
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
      ...anchor("src/entry.ts", 2),
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
