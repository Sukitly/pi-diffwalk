import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  decideFold,
  FOLD_MAX_CHANGED_LINES,
  FOLD_THRESHOLDS,
  foldFromRoutineClaim,
  renderUnitText,
  unitChangedLineCount,
} from "../../src/review/fold.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import type { ReviewUnit, ReviewUnitFeatures } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

const foldable: ReviewUnitFeatures = {
  changesBehavior: 0.1,
  newControlFlow: 0.05,
  touchesBoundary: { choice: "none", confidence: 0.9 },
  kind: { choice: "refactor", confidence: 0.85 },
};

const gates = {
  changedLineCount: 4,
  hasUnresolvedComment: false,
  hasReference: false,
};

test("folds when every feature is clear and reports reasons with percentages", () => {
  const decision = decideFold(foldable, gates);
  assert.equal(decision.fold, true);
  if (!decision.fold) return;
  assert.equal(decision.result.source, "typesafe");
  assert.deepEqual(decision.result.reasons, [
    "No behavior change (90%), no new control flow (95%).",
    "Refactor change touching no boundary.",
  ]);
  assert.equal(
    (decision.result as { features: ReviewUnitFeatures }).features,
    foldable,
  );
});

test("each blocker is named and every blocker is reported", () => {
  const decision = decideFold(
    {
      changesBehavior: FOLD_THRESHOLDS.changesBehavior,
      newControlFlow: 0.9,
      touchesBoundary: { choice: "authorization", confidence: 0.95 },
      kind: { choice: "behavior", confidence: 0.9 },
    },
    {
      changedLineCount: FOLD_MAX_CHANGED_LINES + 1,
      hasUnresolvedComment: true,
      hasReference: false,
    },
  );
  assert.equal(decision.fold, false);
  if (decision.fold) return;
  assert.deepEqual(decision.blockers, [
    `${FOLD_MAX_CHANGED_LINES + 1} changed lines exceed the fold limit of ${FOLD_MAX_CHANGED_LINES}`,
    "a line carries an unresolved comment",
    "changes runtime behavior (75%)",
    "adds control flow (90%)",
    "touches authorization",
    "is a behavior change",
  ]);
  const vowel = decideFold(
    { ...foldable, kind: { choice: "interface", confidence: 0.9 } },
    gates,
  );
  assert.equal(vowel.fold, false);
  if (!vowel.fold) assert.deepEqual(vowel.blockers, ["is an interface change"]);
});

test("an uncertain choice is read as its unsafe alternative", () => {
  const lowBoundary = decideFold(
    {
      ...foldable,
      touchesBoundary: {
        choice: "none",
        confidence: FOLD_THRESHOLDS.choiceConfidence - 0.01,
      },
    },
    gates,
  );
  assert.equal(lowBoundary.fold, false);
  if (!lowBoundary.fold) {
    assert.deepEqual(lowBoundary.blockers, ["touches a public API or type"]);
  }

  const lowKind = decideFold(
    { ...foldable, kind: { choice: "docs", confidence: 0.2 } },
    gates,
  );
  assert.equal(lowKind.fold, false);
  if (!lowKind.fold) {
    assert.deepEqual(lowKind.blockers, ["is a behavior change"]);
  }
});

test("a named reference must be checked and must mirror", () => {
  const unchecked = decideFold(foldable, { ...gates, hasReference: true });
  assert.equal(unchecked.fold, false);
  if (!unchecked.fold) {
    assert.deepEqual(unchecked.blockers, [
      "the named reference was not checked",
    ]);
  }

  const weak = decideFold(
    { ...foldable, mirrorsReference: 0.5 },
    { ...gates, hasReference: true },
  );
  assert.equal(weak.fold, false);
  if (!weak.fold) {
    assert.deepEqual(weak.blockers, [
      "does not mirror the named reference (50%)",
    ]);
  }

  const strong = decideFold(
    { ...foldable, mirrorsReference: 0.92 },
    { ...gates, hasReference: true },
  );
  assert.equal(strong.fold, true);
  if (strong.fold) {
    assert.equal(
      strong.result.reasons.at(-1),
      "Mirrors the named reference (92%).",
    );
  }
});

test("without a judge the agent's routine claim is the fold", () => {
  const base: ReviewUnit = {
    id: "review-unit:1" as ReviewUnit["id"],
    title: "T",
    whyHere: "W",
    context: "C",
    changeSummary: "S",
    reviewFocus: [],
    spans: [],
  };
  assert.equal(foldFromRoutineClaim(base), undefined);
  assert.deepEqual(
    foldFromRoutineClaim({
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
