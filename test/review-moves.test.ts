import assert from "node:assert/strict";
import test from "node:test";
import { detectExactMoves } from "../src/review-moves.ts";
import { makeSnapshot } from "./domain-fixtures.ts";

const MOVED_BLOCK = [
  "const total = computeTotalAmount(items);",
  "const tax = totalAmount * currentTaxRate;",
  "return { totalAmount, taxAmount: tax };",
] as const;

test("detects an exact relocation across files", () => {
  const snapshot = makeSnapshot("snapshot-move", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
  ]);

  const moves = detectExactMoves(snapshot);

  assert.equal(moves.length, 1);
  const move = moves[0];
  assert.ok(move);
  assert.deepEqual(
    {
      path: move.removed.path,
      start: move.removed.start,
      end: move.removed.end,
    },
    { path: "src/from.ts", start: 2, end: 4 },
  );
  assert.deepEqual(
    { path: move.added.path, start: move.added.start, end: move.added.end },
    { path: "src/to.ts", start: 2, end: 4 },
  );
});

test("matches a relocation under one uniform reindentation", () => {
  const snapshot = makeSnapshot("snapshot-reindent", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+    ${line}`), " bottom"],
    },
  ]);

  const moves = detectExactMoves(snapshot);

  assert.equal(moves.length, 1);
  assert.deepEqual(
    moves.map((move) => [move.removed.path, move.added.path]),
    [["src/from.ts", "src/to.ts"]],
  );
});

test("requires one constant indentation offset across the block", () => {
  const snapshot = makeSnapshot("snapshot-mixed-indent", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [
        " top",
        `+    ${MOVED_BLOCK[0]}`,
        `+    ${MOVED_BLOCK[1]}`,
        `+${MOVED_BLOCK[2]}`,
        " bottom",
      ],
    },
  ]);

  assert.deepEqual(detectExactMoves(snapshot), []);
});

test("treats a third occurrence as deliberate ambiguity", () => {
  const snapshot = makeSnapshot("snapshot-triple", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
    {
      path: "src/copy.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
  ]);

  assert.deepEqual(detectExactMoves(snapshot), []);
});

test("drops candidates below the substantiality thresholds", () => {
  const tiny = makeSnapshot("snapshot-tiny", [
    {
      path: "src/from.ts",
      lines: [" head", "-a := 1", "-b := 2", "-c := 3", " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", "+a := 1", "+b := 2", "+c := 3", " bottom"],
    },
  ]);
  assert.deepEqual(detectExactMoves(tiny), []);

  const short = makeSnapshot("snapshot-short", [
    {
      path: "src/from.ts",
      lines: [" head", `-${MOVED_BLOCK[0]}`, `-${MOVED_BLOCK[1]}`, " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", `+${MOVED_BLOCK[0]}`, `+${MOVED_BLOCK[1]}`, " bottom"],
    },
  ]);
  assert.deepEqual(detectExactMoves(short), []);
});

test("suppresses a pair inside one hunk but pairs across hunks of one file", () => {
  const sameHunk = makeSnapshot("snapshot-same-hunk", [
    {
      path: "src/file.ts",
      lines: [
        " head",
        ...MOVED_BLOCK.map((line) => `-${line}`),
        ...MOVED_BLOCK.map((line) => `+${line}`),
        " tail",
      ],
    },
  ]);
  assert.deepEqual(detectExactMoves(sameHunk), []);

  const crossHunk = makeSnapshot("snapshot-cross-hunk", [
    {
      path: "src/file.ts",
      lines: [
        " head",
        ...MOVED_BLOCK.map((line) => `-${line}`),
        " middle",
        ...MOVED_BLOCK.map((line) => `+${line}`),
        " tail",
      ],
    },
  ]);
  const moves = detectExactMoves(crossHunk);
  assert.equal(moves.length, 1);
  const move = moves[0];
  assert.ok(move);
  assert.deepEqual(
    [move.removed.start, move.removed.end, move.added.start, move.added.end],
    [2, 4, 3, 5],
  );
});

test("discards overlapping candidates instead of guessing", () => {
  const shared = [
    "common_alpha := shared_transform_alpha(left)",
    "common_beta := shared_transform_beta(middle)",
    "common_gamma := shared_transform_gamma(right)",
  ] as const;
  const snapshot = makeSnapshot("snapshot-overlap", [
    {
      path: "src/from.ts",
      lines: [
        " head",
        "-anchor_head := unique_head_marker(source)",
        ...shared.map((line) => `-${line}`),
        "-anchor_tail := unique_tail_marker(sink)",
        " tail",
      ],
    },
    {
      path: "src/first.ts",
      lines: [
        " top",
        "+anchor_head := unique_head_marker(source)",
        ...shared.map((line) => `+${line}`),
        " bottom",
      ],
    },
    {
      path: "src/second.ts",
      lines: [
        " top",
        ...shared.map((line) => `+${line}`),
        "+anchor_tail := unique_tail_marker(sink)",
        " bottom",
      ],
    },
  ]);

  assert.deepEqual(detectExactMoves(snapshot), []);
});

test("is deterministic for one snapshot", () => {
  const snapshot = makeSnapshot("snapshot-deterministic", [
    {
      path: "src/from.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    {
      path: "src/to.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
  ]);

  assert.deepEqual(detectExactMoves(snapshot), detectExactMoves(snapshot));
});
