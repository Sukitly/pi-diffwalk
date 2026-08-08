import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  fitRight,
  progressBarSegments,
  selectHeaderGroups,
} from "../src/ui-layout.ts";

test("calculates progress bar segments for empty, partial, and complete review", () => {
  assert.deepEqual(progressBarSegments(0, 2), {
    completed: 0,
    remaining: 12,
  });
  assert.deepEqual(progressBarSegments(1, 2), {
    completed: 6,
    remaining: 6,
  });
  assert.deepEqual(progressBarSegments(2, 2), {
    completed: 12,
    remaining: 0,
  });
  assert.deepEqual(progressBarSegments(0, 0), {
    completed: 0,
    remaining: 12,
  });
});

test("right-aligns styled lines and safely truncates long lines", () => {
  assert.equal(fitRight("status", 10), "    status");

  const styled = fitRight("\u001b[31mok\u001b[39m", 6);
  assert.equal(visibleWidth(styled), 6);
  assert.ok(styled.startsWith("    \u001b[31mok"));

  const truncated = fitRight("123456789", 5);
  assert.equal(visibleWidth(truncated), 5);
  assert.match(truncated, /^12345/);
});

test("drops complete low-priority header groups before reserved body rows", () => {
  const groups = [
    { lines: ["brand"], priority: 90 },
    { lines: ["title"], priority: 80 },
    { lines: ["progress"], priority: 50, minimumRows: 6 },
    { lines: ["status one", "status two"], priority: 40, minimumRows: 10 },
  ];

  assert.deepEqual(selectHeaderGroups(groups, 12, 2), [
    "brand",
    "title",
    "progress",
    "status one",
    "status two",
  ]);
  assert.deepEqual(selectHeaderGroups(groups, 8, 2), [
    "brand",
    "title",
    "progress",
  ]);
  assert.deepEqual(selectHeaderGroups(groups, 4, 2), ["brand", "title"]);
});
