import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  clamp,
  clampedMargin,
  clampOffset,
  fillLine,
  fillScreenHeight,
  progressBarSegments,
  renderBackgroundBlock,
  selectHeaderGroups,
  widthAfterMargin,
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

test("clamp bounds a value and returns the minimum when the range is empty", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 3, 1), 3);
});

test("clampOffset keeps the last viewport full and treats a negative viewport as empty", () => {
  assert.equal(clampOffset(4, 10, 3), 4);
  assert.equal(clampOffset(9, 10, 3), 7);
  assert.equal(clampOffset(-2, 10, 3), 0);
  assert.equal(clampOffset(2, 2, 3), 0);
  assert.equal(clampOffset(15, 10, 0), 10);
  assert.equal(clampOffset(15, 10, -4), 10);
});

test("margins never consume the whole width", () => {
  assert.equal(clampedMargin(10, 3), 3);
  assert.equal(clampedMargin(10, 12), 9);
  assert.equal(clampedMargin(10, -1), 0);
  assert.equal(widthAfterMargin(10, 3), 7);
  assert.equal(widthAfterMargin(10, 12), 1);
  assert.equal(widthAfterMargin(1, 5), 1);
});

test("fillLine pads to the width and truncates beyond it", () => {
  assert.equal(fillLine("ab", 4), "ab  ");
  const truncated = fillLine("abcdef", 4);
  assert.equal(visibleWidth(truncated), 4);
  assert.ok(truncated.startsWith("abcd"));
});

test("fillScreenHeight pads before the footer and truncates from the bottom", () => {
  assert.deepEqual(fillScreenHeight(["h", "b", "f"], 5), [
    "h",
    "b",
    "",
    "",
    "f",
  ]);
  assert.deepEqual(fillScreenHeight(["h", "b", "f"], 2), ["h", "b"]);
});

test("renderBackgroundBlock paints every row to the width after the margin", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => text,
  };
  assert.deepEqual(
    renderBackgroundBlock(["ab", "abcdef"], "userMessageBg", theme, 8, 2),
    [
      "  <userMessageBg>ab    </userMessageBg>",
      "  <userMessageBg>abcdef</userMessageBg>",
    ],
  );
  const [overflow] = renderBackgroundBlock(
    ["abcdefgh"],
    "userMessageBg",
    theme,
    8,
    2,
  );
  assert.ok(overflow?.startsWith("  <userMessageBg>abcdef"));
});
