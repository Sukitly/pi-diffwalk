import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { hashAs } from "../../src/review/ids.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import { createReviewSeries } from "../../src/review/series.ts";
import type { ReviewRouteCandidate } from "../../src/review/types.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";

/**
 * Identifiers are persisted in pi session entries and compared across pi
 * sessions, so the hash formula is a compatibility contract. These values
 * were produced by the implementation that shipped before hashAs was
 * shared; a change here orphans every persisted series and round.
 */
const PINNED_SERIES_ID =
  "review-series:91a0629c52baa0a352acd5ce22affe5988f042b88d9c8a12313df490a179ad5b";
const PINNED_UNIT_ID =
  "review-unit:81e8a55f11849663be30486f62d7b895068ebd30fc8e69f8882b2d0fd5b58231";

test("hashAs keeps the persisted formula: namespace, NUL, JSON, sha256 hex", () => {
  assert.equal(
    hashAs("review-series", {
      repositoryRoot: "/repo",
      sourceBranch: "feature",
      targetRef: "main",
    }),
    PINNED_SERIES_ID,
  );
});

test("hashAs depends on key order, so callers must build values with a fixed shape", () => {
  assert.notEqual(
    hashAs("example", { first: 1, second: 2 }),
    hashAs("example", { second: 2, first: 1 }),
  );
  assert.notEqual(hashAs("one", { value: 1 }), hashAs("two", { value: 1 }));
});

test("series identifiers still match the persisted formula", () => {
  const series = createReviewSeries({
    repositoryRoot: "/repo",
    sourceBranch: "feature",
    targetRef: "main",
  });
  assert.equal(series.id, PINNED_SERIES_ID);
});

test("unit identifiers are hashAs over the snapshot, sequence, and resolved spans", () => {
  const path = "src/entry.ts";
  const snapshot = makeSnapshot("snapshot-route", [
    {
      path,
      lines: [
        " export function entry() {",
        "-  return legacy()",
        "+  return validate(legacy())",
        " }",
      ],
    },
  ]);
  const candidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Entry point",
        whyHere: "Behavior starts here.",
        context: "entry -> validate",
        changeSummary: "Validates the legacy result.",
        reviewFocus: [{ question: "Is the legacy path still reachable?" }],
        spans: [span(path, { old: [2, 2], new: [2, 2] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(
    snapshot,
    computeReviewDelta(snapshot),
    candidate,
  );

  assert.equal(route.units[0]?.id, PINNED_UNIT_ID);
  assert.equal(
    route.units[0]?.id,
    hashAs("review-unit", {
      snapshotId: snapshot.id,
      sequence: 1,
      spans: [
        {
          fileChangeId: fileChangeId("modified", path),
          oldStart: 2,
          oldEnd: 2,
          newStart: 2,
          newEnd: 2,
        },
      ],
    }),
  );
});
