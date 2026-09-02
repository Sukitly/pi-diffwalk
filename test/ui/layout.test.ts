import assert from "node:assert/strict";
import test from "node:test";
import {
  progressBarSegments,
  selectHeaderGroups,
} from "../../src/ui/layout.ts";

test("calculates bounded progress segments within the total width", () => {
  assert.deepEqual(progressBarSegments(0, 2), {
    leftBoundary: "[",
    completed: 0,
    remaining: 10,
    rightBoundary: "]",
  });
  assert.deepEqual(progressBarSegments(1, 2), {
    leftBoundary: "[",
    completed: 5,
    remaining: 5,
    rightBoundary: "]",
  });
  assert.deepEqual(progressBarSegments(2, 2), {
    leftBoundary: "[",
    completed: 10,
    remaining: 0,
    rightBoundary: "]",
  });
  assert.deepEqual(progressBarSegments(0, 0), {
    leftBoundary: "[",
    completed: 0,
    remaining: 10,
    rightBoundary: "]",
  });

  const narrow = progressBarSegments(1, 2, 8);
  assert.equal(
    narrow.leftBoundary.length +
      narrow.completed +
      narrow.remaining +
      narrow.rightBoundary.length,
    8,
  );
});

test("keeps partial progress distinct from empty and complete endpoints", () => {
  assert.deepEqual(progressBarSegments(1, 30), {
    leftBoundary: "[",
    completed: 1,
    remaining: 9,
    rightBoundary: "]",
  });
  assert.deepEqual(progressBarSegments(29, 30), {
    leftBoundary: "[",
    completed: 9,
    remaining: 1,
    rightBoundary: "]",
  });
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
