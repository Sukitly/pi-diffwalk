import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { detectExactMoves } from "../../src/review/moves.ts";
import {
  assessRouteQuality,
  formatAdvisoryNudge,
} from "../../src/review/route-advisory.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import type {
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewSnapshot,
  ReviewSpanCandidate,
} from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

function unit(
  title: string,
  spans: readonly ReviewSpanCandidate[],
): ReviewRouteCandidate["units"][number] {
  return {
    title,
    whyHere: "Fixture ordering.",
    context: "Fixture context.",
    changeSummary: "Fixture change.",
    reviewFocus: [{ question: "Fixture question?" }],
    spans: [...spans],
  };
}

function validate(
  snapshot: ReviewSnapshot,
  units: ReviewRouteCandidate["units"],
  skippedSpans: ReviewRouteCandidate["skippedSpans"] = [],
): ReviewRoute {
  return validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units,
    skippedSpans,
  });
}

function threeFileSnapshot(): ReviewSnapshot {
  return makeSnapshot("snapshot-three", [
    { path: "src/a.ts", lines: [" head", "+alpha", " tail"] },
    { path: "src/b.ts", lines: [" head", "+beta", " tail"] },
    { path: "src/c.ts", lines: [" head", "+gamma", " tail"] },
  ]);
}

const MOVED_BLOCK = [
  "const total = computeTotalAmount(items);",
  "const tax = totalAmount * currentTaxRate;",
  "return { totalAmount, taxAmount: tax };",
] as const;

function moveSnapshot(): ReviewSnapshot {
  return makeSnapshot("snapshot-move", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
  ]);
}

test("flags a route whose units copy the suggested spans one for one", () => {
  const snapshot = threeFileSnapshot();
  // Non-alphabetical order isolates the hunk-mirroring signal.
  const route = validate(snapshot, [
    unit("B", [span("src/b.ts", { new: [2, 2] })]),
    unit("A", [span("src/a.ts", { new: [2, 2] })]),
    unit("C", [span("src/c.ts", { new: [2, 2] })]),
  ]);

  const issues = assessRouteQuality(snapshot, route, []);

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["hunk-mirroring"],
  );
});

test("accepts hunk-sized units once any span is redrawn or units merge", () => {
  const snapshot = threeFileSnapshot();
  const redrawn = validate(snapshot, [
    unit("B", [span("src/b.ts", { new: [1, 3] })]),
    unit("A", [span("src/a.ts", { new: [2, 2] })]),
    unit("C", [span("src/c.ts", { new: [2, 2] })]),
  ]);
  assert.equal(
    assessRouteQuality(snapshot, redrawn, []).some(
      (issue) => issue.code === "hunk-mirroring",
    ),
    false,
  );

  const merged = validate(snapshot, [
    unit("B and A", [
      span("src/b.ts", { new: [2, 2] }),
      span("src/a.ts", { new: [2, 2] }),
    ]),
    unit("C", [span("src/c.ts", { new: [2, 2] })]),
  ]);
  assert.deepEqual(assessRouteQuality(snapshot, merged, []), []);
});

test("keeps small routes exempt from the hunk-mirroring signal", () => {
  const snapshot = makeSnapshot("snapshot-two", [
    { path: "src/a.ts", lines: [" head", "+alpha", " tail"] },
    { path: "src/b.ts", lines: [" head", "+beta", " tail"] },
  ]);
  const route = validate(snapshot, [
    unit("B", [span("src/b.ts", { new: [2, 2] })]),
    unit("A", [span("src/a.ts", { new: [2, 2] })]),
  ]);

  assert.deepEqual(assessRouteQuality(snapshot, route, []), []);
});

test("flags single-file units walking files in alphabetical order", () => {
  const snapshot = threeFileSnapshot();
  // Redrawn spans isolate the ordering signal from hunk mirroring.
  const route = validate(snapshot, [
    unit("A", [span("src/a.ts", { new: [1, 3] })]),
    unit("B", [span("src/b.ts", { new: [1, 3] })]),
    unit("C", [span("src/c.ts", { new: [1, 3] })]),
  ]);

  const issues = assessRouteQuality(snapshot, route, []);

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["alphabetical-order"],
  );
});

test("accepts alphabetical coincidences broken by order or cross-file units", () => {
  const snapshot = threeFileSnapshot();
  const reordered = validate(snapshot, [
    unit("B", [span("src/b.ts", { new: [1, 3] })]),
    unit("A", [span("src/a.ts", { new: [1, 3] })]),
    unit("C", [span("src/c.ts", { new: [1, 3] })]),
  ]);
  assert.deepEqual(assessRouteQuality(snapshot, reordered, []), []);

  const crossFile = validate(snapshot, [
    unit("A with B", [
      span("src/a.ts", { new: [1, 3] }),
      span("src/b.ts", { new: [1, 3] }),
    ]),
    unit("C", [span("src/c.ts", { new: [1, 3] })]),
  ]);
  assert.deepEqual(assessRouteQuality(snapshot, crossFile, []), []);
});

test("flags a detected move split across review units", () => {
  const snapshot = moveSnapshot();
  const moves = detectExactMoves(snapshot);
  assert.equal(moves.length, 1);
  const route = validate(snapshot, [
    unit("Removal", [span("src/from.ts", { old: [2, 4] })]),
    unit("Addition", [span("src/to.ts", { new: [2, 4] })]),
  ]);

  const issues = assessRouteQuality(snapshot, route, moves);

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["split-move"],
  );
  assert.match(
    issues[0]?.message ?? "",
    /src\/from\.ts old 2-4 and src\/to\.ts new 2-4 are an exact relocation/,
  );
});

test("accepts a move kept inside one unit or outside the planned route", () => {
  const snapshot = moveSnapshot();
  const moves = detectExactMoves(snapshot);

  const together = validate(snapshot, [
    unit("Relocation", [
      span("src/from.ts", { old: [2, 4] }),
      span("src/to.ts", { new: [2, 4] }),
    ]),
  ]);
  assert.deepEqual(assessRouteQuality(snapshot, together, moves), []);

  const skippedSide = validate(
    snapshot,
    [unit("Addition", [span("src/to.ts", { new: [2, 4] })])],
    [
      {
        span: span("src/from.ts", { old: [2, 4] }),
        reason: "Pure removal side of a relocation.",
      },
    ],
  );
  assert.deepEqual(assessRouteQuality(snapshot, skippedSide, moves), []);
});

test("formats the advisory nudge as advisory, with a resubmission path", () => {
  const message = formatAdvisoryNudge([
    { code: "split-move", message: "Fixture signal." },
  ]);

  assert.match(message, /passed validation/);
  assert.match(message, /- Fixture signal\./);
  assert.match(message, /advisory signals, not validation failures/);
  assert.match(message, /call the tool again with the same route to proceed/);
});
