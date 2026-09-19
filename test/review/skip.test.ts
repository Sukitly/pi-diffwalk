import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import {
  decideSkip,
  gateReasons,
  REVIEW_THRESHOLDS,
  renderUnitText,
  skipFromRoutineClaim,
  unitChangedLineCount,
} from "../../src/review/skip.ts";
import type { ReviewUnit, ReviewUnitFeatures } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

const quiet: ReviewUnitFeatures = {
  changesBehavior: 0.1,
  newControlFlow: 0.05,
  touchesBoundary: { choice: "none", confidence: 0.9 },
  kind: { choice: "refactor", confidence: 0.85 },
};

const gates = { hasUnresolvedComment: false };

test("skips by default and says why in one or two sentences", () => {
  const decision = decideSkip(quiet, gates);
  assert.equal(decision.review, false);
  if (decision.review) return;
  assert.deepEqual(decision.reasons, ["Refactor change, no boundary."]);
  assert.equal(decision.features, quiet);
});

test("a quiet behavior unit is skipped with the probabilities it was judged on", () => {
  const decision = decideSkip(
    { ...quiet, kind: { choice: "behavior", confidence: 0.9 } },
    gates,
  );
  assert.equal(decision.review, false);
  if (decision.review) return;
  assert.deepEqual(decision.reasons, [
    "Behavior change, no boundary.",
    "No behavior change (90%), no new control flow (95%).",
  ]);
});

test("a boundary always earns a walk, whatever the kind", () => {
  const decision = decideSkip(
    {
      ...quiet,
      kind: { choice: "test", confidence: 0.9 },
      touchesBoundary: { choice: "authorization", confidence: 0.82 },
    },
    gates,
  );
  assert.equal(decision.review, true);
  if (!decision.review) return;
  assert.deepEqual(decision.reasons, ["touches authorization (82%)"]);
  assert.equal(decision.features?.kind.choice, "test");
});

test("behavior or interface code is walked when behavior or control flow changes", () => {
  const behavior = decideSkip(
    {
      ...quiet,
      kind: { choice: "behavior", confidence: 0.9 },
      changesBehavior: REVIEW_THRESHOLDS.changesBehavior,
      newControlFlow: 0.9,
    },
    gates,
  );
  assert.equal(behavior.review, true);
  if (behavior.review) {
    assert.deepEqual(behavior.reasons, [
      "behavior code changes runtime behavior (75%)",
      "behavior code adds control flow (90%)",
    ]);
  }

  const iface = decideSkip(
    {
      ...quiet,
      kind: { choice: "interface", confidence: 0.7 },
      changesBehavior: 0.8,
    },
    gates,
  );
  assert.equal(iface.review, true);
  if (iface.review) {
    assert.deepEqual(iface.reasons, [
      "interface code changes runtime behavior (80%)",
    ]);
  }
});

test("the same changes in test, config, docs, refactor, or generated code are skipped", () => {
  for (const kind of [
    "test",
    "config",
    "docs",
    "refactor",
    "generated",
  ] as const) {
    const decision = decideSkip(
      {
        ...quiet,
        kind: { choice: kind, confidence: 0.9 },
        changesBehavior: 0.95,
        newControlFlow: 0.95,
      },
      gates,
    );
    assert.equal(decision.review, false, kind);
  }
});

test("an uncertain boundary or kind is no reason to walk a unit", () => {
  const weakBoundary = decideSkip(
    {
      ...quiet,
      touchesBoundary: {
        choice: "public-api",
        confidence: REVIEW_THRESHOLDS.choiceConfidence - 0.01,
      },
    },
    gates,
  );
  assert.equal(weakBoundary.review, false);

  const weakKind = decideSkip(
    {
      ...quiet,
      kind: { choice: "behavior", confidence: 0.25 },
      changesBehavior: 0.99,
      newControlFlow: 0.99,
    },
    gates,
  );
  assert.equal(weakKind.review, false);

  const confidentBoundary = decideSkip(
    {
      ...quiet,
      touchesBoundary: {
        choice: "public-api",
        confidence: REVIEW_THRESHOLDS.choiceConfidence,
      },
    },
    gates,
  );
  assert.equal(confidentBoundary.review, true);
});

test("an unresolved comment forces a walk before any feature is read", () => {
  assert.deepEqual(gateReasons({ hasUnresolvedComment: true }), [
    "a line carries your unresolved comment",
  ]);
  const decision = decideSkip(quiet, { hasUnresolvedComment: true });
  assert.equal(decision.review, true);
  if (decision.review) {
    assert.deepEqual(decision.reasons, [
      "a line carries your unresolved comment",
    ]);
  }
});

test("a mirrored reference is reported on the skip and never forces a walk", () => {
  const mirrored = decideSkip({ ...quiet, mirrorsReference: 0.92 }, gates);
  assert.equal(mirrored.review, false);
  if (!mirrored.review) {
    assert.equal(mirrored.reasons.at(-1), "Mirrors the named reference (92%).");
  }
  const unmirrored = decideSkip({ ...quiet, mirrorsReference: 0.1 }, gates);
  assert.equal(unmirrored.review, false);
});

test("without a judge the agent's routine claim is the skip", () => {
  const base: ReviewUnit = {
    id: "review-unit:1" as ReviewUnit["id"],
    title: "T",
    whyHere: "W",
    context: "C",
    changeSummary: "S",
    reviewFocus: [],
    spans: [],
  };
  assert.equal(skipFromRoutineClaim(base), undefined);
  assert.deepEqual(
    skipFromRoutineClaim({
      ...base,
      routine: { reference: "src/a.ts", reason: "Same shape." },
    }),
    { source: "agent", reasons: ["Same shape."] },
  );
});

test("renders a unit as unified diff text with bounded context per span", () => {
  const snapshot = makeSnapshot("snapshot-text", [
    {
      path: "src/a.ts",
      lines: [
        " l1",
        " l2",
        " l3",
        " l4",
        " l5",
        "-old six",
        "+new six",
        " l7",
        " l8",
        " l9",
        " l10",
        " l11",
        " l12",
        "+late",
        " l14",
      ],
    },
    { path: "src/b.ts", lines: [" head", "+b", " tail"] },
  ]);
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Both",
        whyHere: "W",
        context: "C",
        changeSummary: "S",
        reviewFocus: [],
        spans: [
          span("src/a.ts", { old: [6, 6], new: [6, 6] }),
          span("src/a.ts", { new: [13, 13] }),
          span("src/b.ts", { new: [2, 2] }),
        ],
      },
    ],
    skippedSpans: [],
  });
  const unit = route.units[0];
  assert.ok(unit);

  assert.equal(
    renderUnitText(snapshot, unit),
    [
      "--- src/a.ts",
      "@@",
      " l3",
      " l4",
      " l5",
      "-old six",
      "+new six",
      " l7",
      " l8",
      " l9",
      "",
      "--- src/a.ts",
      "@@",
      " l10",
      " l11",
      " l12",
      "+late",
      " l14",
      "",
      "--- src/b.ts",
      "@@",
      " head",
      "+b",
      " tail",
    ].join("\n"),
  );
  assert.equal(unitChangedLineCount(snapshot, unit), 4);
});
