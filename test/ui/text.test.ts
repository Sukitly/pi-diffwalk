import assert from "node:assert/strict";
import test from "node:test";
import {
  oneTerminalLine,
  safeText,
  wrapStyled,
  wrapWithPrefix,
} from "../../src/ui/text.ts";

test("safeText escapes control characters and keeps printable text", () => {
  assert.equal(safeText("plain"), "plain");
  assert.equal(safeText("a\tb"), "a    b");
  assert.equal(safeText("a\rb"), "a\\rb");
  assert.equal(safeText("a\nb"), "a\nb");
  assert.equal(safeText("\u001b[31mred"), "\\x1b[31mred");
  assert.equal(safeText("\u007f"), "\\x7f");
});

test("safeText escapes bidi overrides and C1 controls that could reorder terminal text", () => {
  assert.equal(safeText("\u202e"), "\\u{202e}");
  assert.equal(safeText("\u2066x\u2069"), "\\u{2066}x\\u{2069}");
  assert.equal(safeText("\u200f"), "\\u{200f}");
  assert.equal(safeText("\u061c"), "\\u{61c}");
  assert.equal(safeText("\u0085"), "\\u{85}");
});

test("safeText keeps non-ASCII text including CJK and emoji", () => {
  assert.equal(safeText("中文路径/文件.ts"), "中文路径/文件.ts");
  assert.equal(safeText("naïve ✓"), "naïve ✓");
});

test("oneTerminalLine flattens line terminators so a row cannot span rows", () => {
  assert.equal(oneTerminalLine("a\nb\r\nc"), "a\\nb\\r\\nc");
});

test("wrapStyled wraps to the width and never returns a row wider than it", () => {
  const rows = wrapStyled("one two three four", 9);
  assert.deepEqual(rows, ["one two", "three", "four"]);
  assert.deepEqual(wrapStyled("abc", 0), ["a", "b", "c"]);
});

test("wrapWithPrefix indents continuation rows by the prefix width", () => {
  const rows = wrapWithPrefix("> ", "one two three", 9);
  assert.deepEqual(rows, ["> one two", "  three"]);
});

test("wrapWithPrefix falls back to wrapping prefix and text together when the prefix fills the width", () => {
  assert.deepEqual(wrapWithPrefix("abcd", "ef", 4), ["abcd", "ef"]);
});
