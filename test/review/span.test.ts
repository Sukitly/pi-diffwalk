import assert from "node:assert/strict";
import test from "node:test";
import {
  changedLineKey,
  computeSpanCoverage,
  describeChangedLines,
  listChangedLines,
  listFileChangedLines,
  resolveSpan,
  summarizeChangedRanges,
} from "../../src/review/span.ts";
import type { ResolvedSpan } from "../../src/review/types.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";

function fixture() {
  return makeSnapshot("snapshot-span", [
    {
      path: "src/entry.ts",
      lines: [
        " const before = true",
        "-const removed = 1",
        "+const added = 1",
        " callContract()",
        " tail()",
      ],
    },
    {
      path: "src/contract.ts",
      lines: [" export interface Contract {", "+  value: string", " }"],
    },
  ]);
}

function resolved(
  snapshot: ReturnType<typeof fixture>,
  path: string,
  ranges: Parameters<typeof span>[1],
): ResolvedSpan {
  const result = resolveSpan(snapshot, span(path, ranges), "test span");
  assert.deepEqual(result.issues, []);
  assert.ok(result.span);
  return result.span;
}

test("enumerates changed lines on the side where each line exists", () => {
  const snapshot = fixture();
  const entry = snapshot.changes[0];
  assert.ok(entry);

  assert.deepEqual(
    listFileChangedLines(entry).map((line) => [
      line.side,
      line.line,
      line.text,
    ]),
    [
      ["old", 2, "const removed = 1"],
      ["new", 2, "const added = 1"],
    ],
  );
  assert.equal(listChangedLines(snapshot).length, 3);
});

test("summarizes changed lines as contiguous per-side ranges", () => {
  const snapshot = makeSnapshot("snapshot-ranges", [
    {
      path: "src/a.ts",
      lines: [" a", "+b", "+c", " d", "+e", "-f", "-g"],
    },
  ]);
  const change = snapshot.changes[0];
  assert.ok(change);

  assert.deepEqual(summarizeChangedRanges(change), {
    old: [{ start: 3, end: 4 }],
    new: [
      { start: 2, end: 3 },
      { start: 5, end: 5 },
    ],
  });
});

test("resolves a span to the frozen file and rejects unusable ranges", () => {
  const snapshot = fixture();

  assert.deepEqual(
    resolveSpan(snapshot, span("src/entry.ts", { new: [1, 3] }), "unit 1").span
      ?.fileChangeId,
    fileChangeId("modified", "src/entry.ts"),
  );

  assert.equal(
    resolveSpan(snapshot, span("src/missing.ts", { new: [1, 2] }), "unit 1")
      .issues[0]?.code,
    "unknown-path",
  );
  assert.equal(
    resolveSpan(snapshot, { path: "src/entry.ts" }, "unit 1").issues[0]?.code,
    "missing-range",
  );
  assert.equal(
    resolveSpan(snapshot, { path: "src/entry.ts", newStart: 2 }, "unit 1")
      .issues[0]?.code,
    "incomplete-range",
  );
  assert.equal(
    resolveSpan(snapshot, span("src/entry.ts", { new: [3, 2] }), "unit 1")
      .issues[0]?.code,
    "inverted-range",
  );
  assert.equal(
    resolveSpan(snapshot, span("src/entry.ts", { new: [1, 99] }), "unit 1")
      .issues[0]?.code,
    "out-of-range",
  );
  assert.equal(
    resolveSpan(snapshot, span("src/entry.ts", { new: [3, 4] }), "unit 1")
      .issues[0]?.code,
    "no-changed-lines",
  );
});

test("counts only changed lines toward coverage, so units may share context", () => {
  const snapshot = fixture();
  const first = resolved(snapshot, "src/entry.ts", { new: [1, 2] });
  const second = resolved(snapshot, "src/entry.ts", { old: [1, 2] });

  const coverage = computeSpanCoverage(snapshot, {
    unitSpans: [[first], [second]],
    skippedSpans: [],
  });

  assert.deepEqual(coverage.duplicated, []);
  assert.deepEqual(
    coverage.coveredByUnit.map((lines) => lines.length),
    [1, 1],
  );
  assert.deepEqual(
    coverage.uncovered.map((line) => [line.side, line.line]),
    [["new", 2]],
  );
});

test("reports a changed line covered by two units as duplicated", () => {
  const snapshot = fixture();
  const wide = resolved(snapshot, "src/entry.ts", { old: [1, 2], new: [1, 2] });
  const narrow = resolved(snapshot, "src/entry.ts", { new: [2, 2] });

  const coverage = computeSpanCoverage(snapshot, {
    unitSpans: [[wide], [narrow]],
    skippedSpans: [],
  });

  assert.deepEqual(
    coverage.duplicated.map((entry) => [
      entry.line.side,
      entry.line.line,
      entry.unitIndexes,
    ]),
    [["new", 2, [0, 1]]],
  );
});

test("reports a line that is both covered and skipped as conflicting", () => {
  const snapshot = fixture();
  const covered = resolved(snapshot, "src/entry.ts", { new: [2, 2] });

  const coverage = computeSpanCoverage(snapshot, {
    unitSpans: [[covered]],
    skippedSpans: [covered],
  });

  assert.deepEqual(
    coverage.conflicting.map((line) => [line.side, line.line]),
    [["new", 2]],
  );
});

test("describes changed lines as compact per-file ranges", () => {
  const snapshot = makeSnapshot("snapshot-describe", [
    { path: "src/a.ts", lines: [" a", "+b", "+c", "+d", " e"] },
  ]);

  assert.deepEqual(describeChangedLines(snapshot, listChangedLines(snapshot)), [
    "src/a.ts new 2-4",
  ]);
});

test("keys changed lines uniquely across files and sides", () => {
  const snapshot = fixture();
  const keys = listChangedLines(snapshot).map((line) => changedLineKey(line));

  assert.equal(new Set(keys).size, keys.length);
});
