import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { computeReviewDelta } from "../src/review-delta.ts";
import {
  ReviewRouteValidationError,
  validateReviewRoute,
} from "../src/route-validation.ts";
import {
  type ReviewRouteCandidate,
  ReviewRouteCandidateSchema,
  type ReviewSnapshot,
  type ReviewSpan,
} from "../src/types.ts";
import { makeRound, makeSnapshot, span } from "./domain-fixtures.ts";

function fixture(): ReviewSnapshot {
  return makeSnapshot("snapshot-route", [
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
  spans: readonly ReviewSpan[],
  overrides: Partial<ReviewRouteCandidate["units"][number]> = {},
): ReviewRouteCandidate["units"][number] {
  return {
    title: "Entry point",
    whyHere: "Behavior starts here.",
    context: "entry -> validate",
    changeSummary: "Validates the legacy result.",
    reviewFocus: ["Is the legacy path still reachable?"],
    spans: [...spans],
    ...overrides,
  } as ReviewRouteCandidate["units"][number];
}

function route(
  snapshot: ReviewSnapshot,
  units: readonly ReviewRouteCandidate["units"][number][],
  skippedSpans: ReviewRouteCandidate["skippedSpans"] = [],
): ReviewRouteCandidate {
  return { snapshotId: snapshot.id, units: [...units], skippedSpans };
}

function codesOf(error: unknown): readonly string[] {
  assert.ok(error instanceof ReviewRouteValidationError);
  return error.issues.map((issue) => issue.code);
}

test("exports an agent schema that accepts spans and rejects patch content", () => {
  const valid = {
    snapshotId: "snapshot-route",
    units: [
      {
        title: "Entry",
        whyHere: "Start here.",
        context: "entry -> validate",
        changeSummary: "Adds validation.",
        reviewFocus: ["Is it correct?"],
        spans: [{ path: "src/entry.ts", newStart: 2, newEnd: 3 }],
      },
    ],
    skippedSpans: [],
  };
  assert.equal(Value.Check(ReviewRouteCandidateSchema, valid), true);

  assert.equal(
    Value.Check(ReviewRouteCandidateSchema, {
      ...valid,
      units: [{ ...valid.units[0], diff: "+const value = 1" }],
    }),
    false,
  );
  assert.equal(
    Value.Check(ReviewRouteCandidateSchema, {
      ...valid,
      units: [{ ...valid.units[0], spans: [] }],
    }),
    false,
  );
  assert.equal(
    Value.Check(ReviewRouteCandidateSchema, {
      ...valid,
      units: [
        { ...valid.units[0], spans: [{ path: "src/entry.ts", newStart: 0 }] },
      ],
    }),
    false,
  );
  assert.equal(
    Value.Check(ReviewRouteCandidateSchema, {
      ...valid,
      units: [
        {
          ...valid.units[0],
          reviewFocus: ["One?", "Two?", "Three?", "Four?"],
        },
      ],
    }),
    false,
  );
});

test("rejects more than three review focus questions", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [
          unit(
            [
              span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
              span("src/contract.ts", { new: [2, 2] }),
            ],
            { reviewFocus: ["One?", "Two?", "Three?", "Four?"] },
          ),
        ]),
      ),
    (error: unknown) => codesOf(error).includes("review-focus-limit"),
  );
});

test("accepts a route whose units cover every changed line once", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  const validated = validateReviewRoute(
    snapshot,
    delta,
    route(snapshot, [
      unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
      unit([span("src/contract.ts", { new: [2, 2] })], {
        title: "Public contract",
      }),
    ]),
  );

  assert.equal(validated.units.length, 2);
  assert.equal(validated.units[0]?.spans[0]?.path, "src/entry.ts");
  assert.notEqual(validated.units[0]?.id, validated.units[1]?.id);
});

test("assigns deterministic unit identifiers", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);
  const candidate = route(snapshot, [
    unit([
      span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
      span("src/contract.ts", { new: [2, 2] }),
    ]),
  ]);

  assert.deepEqual(
    validateReviewRoute(snapshot, delta, candidate).units.map((u) => u.id),
    validateReviewRoute(snapshot, delta, candidate).units.map((u) => u.id),
  );
});

test("lets one unit span several files", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  const validated = validateReviewRoute(
    snapshot,
    delta,
    route(snapshot, [
      unit([
        span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
        span("src/contract.ts", { new: [2, 2] }),
      ]),
    ]),
  );

  assert.equal(validated.units.length, 1);
  assert.deepEqual(
    validated.units[0]?.spans.map((s) => s.path),
    ["src/entry.ts", "src/contract.ts"],
  );
});

test("rejects a route that leaves changed lines uncovered", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [
          unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
        ]),
      ),
    (error: unknown) => {
      assert.ok(codesOf(error).includes("missing-coverage"));
      assert.ok(
        error instanceof ReviewRouteValidationError &&
          error.message.includes("src/contract.ts new 2-2"),
      );
      return true;
    },
  );
});

test("rejects a changed line claimed by two units", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [
          unit([span("src/entry.ts", { old: [1, 3], new: [1, 3] })]),
          unit([span("src/entry.ts", { new: [2, 2] })]),
          unit([span("src/contract.ts", { new: [2, 2] })]),
        ]),
      ),
    (error: unknown) => codesOf(error).includes("duplicate-coverage"),
  );
});

test("accepts an explicit skip and rejects one without a reason", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  const validated = validateReviewRoute(
    snapshot,
    delta,
    route(
      snapshot,
      [unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })])],
      [
        {
          span: span("src/contract.ts", { new: [2, 2] }),
          reason: "Generated type surface reviewed at its source.",
        },
      ],
    ),
  );
  assert.equal(validated.skippedSpans.length, 1);
  assert.equal(validated.skippedSpans[0]?.span.path, "src/contract.ts");

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(
          snapshot,
          [unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })])],
          [{ span: span("src/contract.ts", { new: [2, 2] }), reason: "  " }],
        ),
      ),
    (error: unknown) => codesOf(error).includes("empty-skip-reason"),
  );
});

test("rejects a line that is both covered and skipped", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(
          snapshot,
          [
            unit([
              span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
              span("src/contract.ts", { new: [2, 2] }),
            ]),
          ],
          [
            {
              span: span("src/contract.ts", { new: [2, 2] }),
              reason: "Also skipped.",
            },
          ],
        ),
      ),
    (error: unknown) => codesOf(error).includes("skip-coverage-conflict"),
  );
});

test("rejects unknown paths, empty ranges, and regions without changed lines", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [unit([span("src/missing.ts", { new: [1, 2] })])]),
      ),
    (error: unknown) => codesOf(error).includes("invalid-span"),
  );

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [unit([span("src/entry.ts", { new: [4, 4] })])]),
      ),
    (error: unknown) => codesOf(error).includes("invalid-span"),
  );
});

test("rejects blank metadata and reports every issue at once", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [
          unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })], {
            title: "  ",
            whyHere: "",
            reviewFocus: ["  "],
          }),
        ]),
      ),
    (error: unknown) => {
      const codes = codesOf(error);
      assert.ok(codes.filter((code) => code === "empty-field").length >= 3);
      assert.ok(codes.includes("missing-coverage"));
      return true;
    },
  );
});

test("rejects a route that skips every line requiring review", () => {
  const snapshot = fixture();
  const delta = computeReviewDelta(snapshot);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(
          snapshot,
          [],
          [
            {
              span: span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
              reason: "Skipped.",
            },
            {
              span: span("src/contract.ts", { new: [2, 2] }),
              reason: "Skipped.",
            },
          ],
        ),
      ),
    (error: unknown) => codesOf(error).includes("missing-review-unit"),
  );
});

test("accepts an empty route when no line requires review", () => {
  const snapshot = makeSnapshot("snapshot-empty", []);
  const delta = computeReviewDelta(snapshot);

  const validated = validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units: [],
    skippedSpans: [],
  });

  assert.deepEqual(validated.units, []);
  assert.deepEqual(validated.skippedSpans, []);
});

test("rejects routing or skipping a carried-forward line", () => {
  const snapshot = fixture();
  const baseline = makeRound({ id: "round-1", snapshot });
  const delta = computeReviewDelta(snapshot, baseline);
  assert.ok(delta.lines.every((line) => line.type === "carried-forward"));

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(snapshot, [
          unit([span("src/entry.ts", { old: [2, 2], new: [2, 2] })]),
        ]),
      ),
    (error: unknown) => codesOf(error).includes("carried-forward-reference"),
  );

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(
          snapshot,
          [],
          [
            {
              span: span("src/entry.ts", { old: [2, 2], new: [2, 2] }),
              reason: "Already reviewed.",
            },
          ],
        ),
      ),
    (error: unknown) => codesOf(error).includes("carried-forward-reference"),
  );
});

test("rejects skipping a line whose earlier comment is unresolved", () => {
  const snapshot = fixture();
  const baseline = makeRound({
    id: "round-1",
    snapshot,
    dispositions: { "src/contract.ts:new:2": "commented" },
  });
  const delta = computeReviewDelta(snapshot, baseline);

  assert.throws(
    () =>
      validateReviewRoute(
        snapshot,
        delta,
        route(
          snapshot,
          [],
          [
            {
              span: span("src/contract.ts", { new: [2, 2] }),
              reason: "Not worth re-reading.",
            },
          ],
        ),
      ),
    (error: unknown) => codesOf(error).includes("unresolved-comment-skip"),
  );
});
