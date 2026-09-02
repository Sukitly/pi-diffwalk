import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  cardTheme,
  createHarness,
  inlineTheme,
  makeInlineDiffFixture,
  makeMixedSideOverlapFixture,
  makeOtherUnitInsideSpanFixture,
  makeSkippedInsideSpanFixture,
  makeUiFixture,
  press,
  renderText,
  spanHeaderTheme,
} from "./harness.ts";

test("comment editor repeats the walkthrough highlighted file header", () => {
  const harness = createHarness(80, 24, makeUiFixture(), {
    theme: spanHeaderTheme,
  });
  const styledPath =
    "\u001b[35m\u001b[1msrc/entry 文\\nfile.ts\u001b[22m\u001b[39m";
  const walkthroughPath = harness.component
    .render(80)
    .find((line) => line.includes("src/entry"));
  assert.ok(walkthroughPath);
  assert.ok(walkthroughPath.includes(styledPath));

  press(harness.component, "c");
  const editorPath = harness.component
    .render(80)
    .find((line) => line.includes("src/entry"));
  assert.ok(editorPath);
  assert.equal(editorPath.trimEnd(), walkthroughPath.trimEnd());
  assert.doesNotMatch(editorPath, /\b(?:old|new)\b|"/);
});

test("renders the frozen context window around the anchored line", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c");
  const editor = renderText(harness);
  const compactAdded = editor
    .split("\n")
    .find((line) => line.includes("+const value = validate"));

  assert.match(editor, /context line 1/);
  assert.match(editor, />\s+5\s+-const value = request\.value/);
  assert.match(compactAdded ?? "", /…/);
  assert.match(editor, /context line 7/);
  assert.doesNotMatch(editor, /context line [08]/);
});

test("shows every wrapped row of a long anchored line in the comment editor", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "j", "c");
  const editor = renderText(harness);

  assert.match(editor, />\s+5\s+\+const value = validate/);
  assert.match(editor, /TAIL_END/);
});

test("uses the embedded Editor for multiline Chinese comments with IME focus", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c");
  const editor = renderText(harness);
  assert.match(editor, /Review comment/);
  assert.equal(editor.match(/Review comment/g)?.length, 1);
  assert.ok(editor.includes(CURSOR_MARKER));

  press(
    harness.component,
    "请",
    "检",
    "查",
    "\n",
    "失",
    "败",
    "路",
    "径",
    "\r",
  );

  const comment = harness.state.review.comments[0];
  assert.equal(comment?.body, "请检查\n失败路径");
  assert.equal(comment?.side, "old");
  assert.equal(comment?.line, 5);
  assert.match(renderText(harness), /1 comment/);
  assert.match(
    renderText(harness),
    /\[Draft comment\][\s\S]*请检查[\s\S]*失败路径/,
  );
});

test("keeps the anchor and editor viewport semantics on a short screen", () => {
  const harness = createHarness(30, 8);

  press(
    harness.component,
    "c",
    "o",
    "n",
    "e",
    "\n",
    "t",
    "w",
    "o",
    "\n",
    "t",
    "h",
    "r",
    "e",
    "e",
  );
  const output = renderText(harness);
  const borderRows = output.split("\n").filter((line) => line.includes("─"));

  assert.match(output, /src\/entry/);
  assert.match(output, />\s+5\s+-const value/);
  assert.ok(output.includes(CURSOR_MARKER));
  assert.equal(borderRows.length, 2);
  assert.match(borderRows[0] ?? "", /↑ 2 more/);
  assert.match(output.split("\n").at(-1) ?? "", /Enter save/);
});

test("marks a truncated comment path explicitly", () => {
  const harness = createHarness(20, 24);

  press(harness.component, "c");
  const pathRow = renderText(harness)
    .split("\n")
    .find((line) => line.includes("src/"));

  assert.match(pathRow ?? "", /…/);
});

test("preserves ownership and adjacent draft markers in comment context", () => {
  const harness = createHarness(100, 24, makeOtherUnitInsideSpanFixture());

  press(harness.component, "c");
  let editor = renderText(harness);
  assert.match(editor, /routed to unit "Fallback removal"/);
  assert.doesNotMatch(editor, /inner removal/);

  press(
    harness.component,
    "\u001b",
    "j",
    "c",
    "D",
    "r",
    "a",
    "f",
    "t",
    "\r",
    "g",
    "g",
    "c",
  );
  editor = renderText(harness);
  assert.match(editor, /●\s+4\s+\+outer end/);
});

test("uses the walkthrough skip vocabulary in comment context", () => {
  const harness = createHarness(100, 24, makeSkippedInsideSpanFixture());

  press(harness.component, "c");
  const editor = renderText(harness);

  assert.match(editor, /skipped: Generated output is reviewed at its source/);
  assert.doesNotMatch(editor, /generated removed/);
});

test("uses the walkthrough carried-forward vocabulary in comment context", () => {
  const harness = createHarness(100, 24, makeMixedSideOverlapFixture());

  press(harness.component, "c");
  const editor = renderText(harness);

  assert.match(editor, /reviewed in an earlier round/);
  assert.doesNotMatch(editor, /carried one|carried two/);
});

test("keeps valid one-line replacement highlighting in comment context", () => {
  const harness = createHarness(
    100,
    24,
    makeInlineDiffFixture([
      " head",
      "-return oldValue",
      "+return newValue",
      " tail",
    ]),
    { theme: inlineTheme },
  );

  press(harness.component, "c");
  const editor = renderText(harness);

  assert.match(editor, /return \[\[oldValue\]\]/);
  assert.match(editor, /return \[\[newValue\]\]/);
});

test("does not invent inline pairs when the context cuts a larger replacement", () => {
  const harness = createHarness(
    100,
    24,
    makeInlineDiffFixture([
      "-old alpha",
      "-old beta",
      "+new beta",
      " context a",
      "+target line",
      " context b",
      " context c",
    ]),
    { theme: inlineTheme },
  );

  press(harness.component, "j", "j", "j", "c");

  assert.doesNotMatch(renderText(harness), /\[\[/);
});

test("renders a saved draft as a full-width message card", () => {
  const width = 100;
  const harness = createHarness(width, 24, makeUiFixture(), {
    theme: cardTheme,
  });

  press(harness.component, "c", "C", "h", "e", "c", "k", "\r");
  const background = `${" ".repeat(14)}\u001b[48;5;24m`;
  const cardRows = harness.component
    .render(width)
    .filter((line) => line.startsWith(background));

  assert.ok(
    cardRows.some((line) => line.startsWith(`${background}  [Draft comment]`)),
  );
  assert.ok(cardRows.some((line) => line.startsWith(`${background}  Check`)));
  assert.equal(
    cardRows.every(
      (line) => visibleWidth(line) === width && line.endsWith("\u001b[49m"),
    ),
    true,
  );
});

test("invalidates cached editor output when focus changes", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c");

  harness.component.focused = false;
  assert.equal(renderText(harness).includes(CURSOR_MARKER), false);
  harness.component.focused = true;
  assert.equal(renderText(harness).includes(CURSOR_MARKER), true);
});

test("prefills an existing comment and discards an edit without changing it", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "O", "r", "i", "g", "i", "n", "a", "l", "\r");

  press(harness.component, "c");
  assert.match(renderText(harness), /Original/);
  press(harness.component, "!", "\u001b");

  assert.equal(harness.state.review.comments[0]?.body, "Original");
  assert.match(renderText(harness), /DiffWalk \/ Review/);
});

test("keeps comment input errors local to the editor", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c", "\r");
  assert.match(renderText(harness), /Review comment body must not be blank/);
  assert.deepEqual(harness.state.review.comments, []);
  assert.ok(renderText(harness).includes(CURSOR_MARKER));

  press(harness.component, "V");
  assert.doesNotMatch(
    renderText(harness),
    /Review comment body must not be blank/,
  );
});

test("deletes the selected comment idempotently with transient feedback", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "e", "l", "e", "t", "e", "\r");

  press(harness.component, "d");
  assert.deepEqual(harness.state.review.comments, []);
  assert.match(renderText(harness), /Deleted the comment/);

  press(harness.component, "d");
  assert.match(renderText(harness), /selected line has no comment/);
  press(harness.component, "j");
  assert.doesNotMatch(renderText(harness), /selected line has no comment/);
});
