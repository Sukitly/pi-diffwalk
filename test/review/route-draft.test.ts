import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  appendReviewRouteUnit,
  createReviewRouteDraft,
  finishReviewRouteDraft,
} from "../../src/review/route-draft.ts";
import { ReviewRouteValidationError } from "../../src/review/route-validation.ts";
import type {
  ReviewSnapshot,
  ReviewSpan,
  ReviewUnitCandidate,
} from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

function fixture(): ReviewSnapshot {
  return makeSnapshot("snapshot-draft", [
    {
      path: "src/entry.ts",
      lines: [
        " export function entry() {",
        "-  return legacy()",
        "+  return validate(legacy())",
        " }",
      ],
    },
    {
      path: "src/contract.ts",
      lines: [" export interface Contract {", "+  value: string", " }"],
    },
  ]);
}

function unit(
  title: string,
  spans: readonly ReviewSpan[],
  overrides: Partial<ReviewUnitCandidate> = {},
): ReviewUnitCandidate {
  return {
    title,
    whyHere: "Behavior starts here.",
    context: "entry -> validate",
    changeSummary: "Validates the legacy result.",
    reviewFocus: [{ question: "Is the legacy path still reachable?" }],
    spans: [...spans],
    ...overrides,
  } as ReviewUnitCandidate;
}

function codesOf(error: unknown): readonly string[] {
  assert.ok(error instanceof ReviewRouteValidationError);
  return error.issues.map((issue) => issue.code);
}

test("accepts units one at a time and reports what is still unrouted", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const empty = createReviewRouteDraft(snapshot.id);

  const first = appendReviewRouteUnit(
    snapshot,
    delta,
    empty,
    unit("Entry point", [span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
  );
  assert.equal(first.unitCount, 1);
  assert.equal(first.acceptedUnit.title, "Entry point");
  assert.equal(first.coveredLineCount, 2);
  assert.deepEqual(first.remaining, [
    { path: "src/contract.ts", ranges: ["new 2"], lineCount: 1 },
  ]);

  const second = appendReviewRouteUnit(
    snapshot,
    delta,
    first.draft,
    unit("Contract field", [span("src/contract.ts", { new: [2, 2] })]),
  );
  assert.equal(second.unitCount, 2);
  assert.deepEqual(second.remaining, []);

  const route = finishReviewRouteDraft(snapshot, delta, second.draft, []);
  assert.deepEqual(
    route.units.map((routed) => routed.title),
    ["Entry point", "Contract field"],
  );
});

test("a rejected unit leaves the accepted ones untouched", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const first = appendReviewRouteUnit(
    snapshot,
    delta,
    createReviewRouteDraft(snapshot.id),
    unit("Entry point", [span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
  );

  assert.throws(
    () =>
      appendReviewRouteUnit(
        snapshot,
        delta,
        first.draft,
        unit("Overlaps the first unit", [
          span("src/entry.ts", { new: [2, 2] }),
        ]),
      ),
    (error: unknown) => codesOf(error).includes("duplicate-coverage"),
  );
  assert.throws(
    () =>
      appendReviewRouteUnit(
        snapshot,
        delta,
        first.draft,
        unit("Blank", [], {}),
      ),
    (error: unknown) => codesOf(error).includes("empty-unit"),
  );

  assert.deepEqual(first.draft.units.length, 1);
  const recovered = appendReviewRouteUnit(
    snapshot,
    delta,
    first.draft,
    unit("Contract field", [span("src/contract.ts", { new: [2, 2] })]),
  );
  assert.deepEqual(recovered.remaining, []);
});

test("an incomplete draft is rejected only when it is finished", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const partial = appendReviewRouteUnit(
    snapshot,
    delta,
    createReviewRouteDraft(snapshot.id),
    unit("Entry point", [span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
  );

  assert.throws(
    () => finishReviewRouteDraft(snapshot, delta, partial.draft, []),
    (error: unknown) => codesOf(error).includes("missing-coverage"),
  );

  const route = finishReviewRouteDraft(snapshot, delta, partial.draft, [
    { span: span("src/contract.ts", { new: [2, 2] }), reason: "Type only." },
  ]);
  assert.equal(route.skippedSpans.length, 1);
});

test("an empty draft cannot be finished while lines still need review", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      finishReviewRouteDraft(
        snapshot,
        delta,
        createReviewRouteDraft(snapshot.id),
        [],
      ),
    (error: unknown) => codesOf(error).includes("missing-review-unit"),
  );
});
