import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ansiTheme,
  createHarness,
  hierarchyTheme,
  inlineTheme,
  makeInlineDiffFixture,
  makeLongSummaryFixture,
  makeUiFixture,
  plainTheme,
  press,
  progressBarTheme,
  renderText,
} from "./harness.ts";

test("shows checks at their anchors and keeps the narrative in details", () => {
  const harness = createHarness(100, 30);
  const lines = harness.component.render(100).map((line) => line.trimEnd());
  const walkthrough = lines.join("\n");

  assert.match(walkthrough, /src\/entry 文\\nfile\.ts/);
  assert.match(walkthrough, />\s+5\s+-const value = request\.value/);
  assert.doesNotMatch(walkthrough, /request -> validate|Why this comes next/);
  assert.doesNotMatch(walkthrough, /Review checks/);

  const addedIndex = lines.findIndex((line) => line.includes("TAIL_END"));
  assert.ok(addedIndex > 0);
  assert.match(lines[addedIndex - 1] ?? "", /^ {12}5 \+const value = validate/);
  assert.equal(
    lines[addedIndex + 1],
    `${" ".repeat(14)}Does validation preserve compatibility?`,
  );
  assert.equal(lines[3], "");
  assert.equal(
    lines[4],
    "The request path now validates a value before execution.",
  );
  assert.equal(lines[5], "");
  assert.equal(lines[6], "  ? Does the failure path remain explicit?");
  assert.equal(lines[7], "");
  assert.equal(lines[8], "src/entry 文\\nfile.ts");

  press(harness.component, "e");
  const explanation = renderText(harness);
  assert.match(explanation, /DiffWalk \/ Details/);
  assert.match(explanation, /Why this comes next/);
  assert.match(explanation, /Context to keep in mind/);
  assert.match(explanation, /Change\s+The request path now validates/);
  assert.match(
    explanation,
    /Review checks\s+\? Does validation preserve compatibility\? \(src\/entry 文[\s\S]*new 5\)\s+\? Does the failure path remain explicit\? \(whole unit\)/,
  );
  assert.doesNotMatch(explanation, /\n {6}1 {5}1 {2}context line 0/);
});

test("shows the anchored check while a comment on that line is edited", () => {
  const harness = createHarness(100, 30);
  press(harness.component, "j", "c");
  const lines = harness.component.render(100).map((line) => line.trimEnd());
  const anchorIndex = lines.findIndex((line) => line.includes("TAIL_END"));
  const editorIndex = lines.indexOf("─".repeat(100));

  assert.ok(anchorIndex > 0);
  assert.match(
    lines[anchorIndex - 1] ?? "",
    /^> {11}5 \+const value = validate/,
  );
  assert.equal(
    lines[anchorIndex + 1],
    `${" ".repeat(14)}Does validation preserve compatibility?`,
  );
  assert.ok(editorIndex > anchorIndex + 1);
  assert.doesNotMatch(lines.join("\n"), /Does the failure path/);
});

test("paints an anchored line and its question as one block", () => {
  const blockTheme = {
    ...plainTheme,
    bg: (color: Parameters<Theme["bg"]>[0], text: string) =>
      color === "customMessageBg"
        ? `[block]${text}[/block]`
        : color === "selectedBg"
          ? `[selected]${text}[/selected]`
          : text,
  };
  const harness = createHarness(100, 30, makeUiFixture(), {
    theme: blockTheme,
  });
  // Rows are cut to the terminal width, so only the opening marker survives.
  const inBlock = (line: string | undefined): boolean =>
    (line ?? "").startsWith("[block]");

  let lines = harness.component.render(100);
  const anchorIndex = lines.findIndex((line) => line.includes("TAIL_END"));
  assert.ok(anchorIndex > 0);
  assert.equal(inBlock(lines[anchorIndex - 1]), true);
  assert.equal(inBlock(lines[anchorIndex]), true);
  assert.equal(inBlock(lines[anchorIndex + 1]), true);
  assert.match(lines[anchorIndex + 1] ?? "", /Does validation preserve/);
  assert.equal(inBlock(lines[anchorIndex + 2]), false);
  assert.equal(inBlock(lines[anchorIndex - 2]), false);

  press(harness.component, "j");
  lines = harness.component.render(100);
  assert.match(lines[anchorIndex - 1] ?? "", /^\[selected\]>/);
  assert.equal(inBlock(lines[anchorIndex - 1]), false);
  assert.equal(inBlock(lines[anchorIndex + 1]), true);
});

test("wraps anchored checks under the diff gutter", () => {
  const harness = createHarness(50, 30);
  const lines = harness.component.render(50).map((line) => line.trimEnd());
  const start = lines.findIndex((line) =>
    line.startsWith(`${" ".repeat(14)}Does validation`),
  );

  assert.ok(start > 0);
  assert.match(lines[start] ?? "", /^ {14}Does validation preserve$/);
  assert.match(lines[start + 1] ?? "", /^ {14}compatibility\?$/);
});

test("drops the unit checks, then the summary, before the diff runs short", () => {
  const harness = createHarness(100, 17);
  const summary = "The request path now validates a value before execution.";

  let lines = harness.component.render(100).map((line) => line.trimEnd());
  assert.equal(lines[4], summary);
  assert.equal(lines[6], "  ? Does the failure path remain explicit?");

  harness.terminal.rows = 16;
  lines = harness.component.render(100).map((line) => line.trimEnd());
  assert.equal(lines[4], summary);
  assert.equal(lines[5], "");
  assert.equal(lines[6], "src/entry 文\\nfile.ts");
  assert.doesNotMatch(lines.join("\n"), /Does the failure path/);
  assert.match(
    lines.join("\n"),
    /^ {14}Does validation preserve compatibility\?$/m,
  );

  harness.terminal.rows = 14;
  lines = harness.component.render(100).map((line) => line.trimEnd());
  assert.equal(lines[3], "");
  assert.equal(lines[4], "src/entry 文\\nfile.ts");

  harness.terminal.rows = 7;
  lines = harness.component.render(100).map((line) => line.trimEnd());
  assert.notEqual(lines[3], "");
  assert.doesNotMatch(
    lines.join("\n"),
    /Does the failure path|validates a value/,
  );
});

test("cuts a long summary to three rows above the diff", () => {
  const harness = createHarness(60, 30, makeLongSummaryFixture());
  const lines = harness.component.render(60).map((line) => line.trimEnd());
  const summaryRows = lines.filter((line) =>
    line.includes("downstream behavior"),
  );

  assert.equal(summaryRows.length, 3);
  assert.match(summaryRows[2] ?? "", /…$/);
  assert.equal(lines[7], "");
});

test("keeps walkthrough spacing out of the details header", () => {
  const harness = createHarness(100, 30);

  press(harness.component, "e");
  const lines = harness.component.render(100).map((line) => line.trimEnd());
  assert.match(lines[0] ?? "", /^DiffWalk \/ Details.*Unit 1\/2$/);
  assert.equal(lines[1], "Request entry point\\nsecondary heading");
});

test("keeps the complete long summary in details", () => {
  const harness = createHarness(60, 30, makeLongSummaryFixture());

  assert.doesNotMatch(renderText(harness), /downstream behavior 8\./);

  press(harness.component, "e");
  const details = renderText(harness);
  assert.match(details, /downstream behavior 1\./);
  assert.match(details, /downstream behavior 8\./);
});

test("uses one check marker role in walkthrough and details", () => {
  const harness = createHarness(100, 30, makeUiFixture(), {
    theme: hierarchyTheme,
  });
  const marker = "\u001b[35m? \u001b[39m\u001b[37mDoes validation";

  const walkthrough = renderText(harness);
  assert.ok(walkthrough.includes(`${" ".repeat(14)}\u001b[37mDoes validation`));
  assert.ok(
    walkthrough.includes(
      "  \u001b[35m? \u001b[39m\u001b[37mDoes the failure path",
    ),
  );

  press(harness.component, "e");
  const details = renderText(harness);
  assert.ok(details.includes(`\n${marker}`));
  assert.ok(
    details.includes("\u001b[37m\u001b[1mReview checks\u001b[22m\u001b[39m"),
  );
});

test("shows complete responsive header information when height permits", () => {
  const harness = createHarness(120, 30);

  let lines = harness.component.render(120).map((line) => line.trimEnd());
  const wideHeader = lines.slice(0, 4).join("\n");
  assert.match(lines[0] ?? "", /^DiffWalk \/ Review.*Unit 1\/2$/);
  assert.match(wideHeader, /Request entry point\\nsecondary heading/);
  assert.match(
    wideHeader,
    /0\/2 reviewed\s+0 comments · 1 skipped · 2 unsupported\s+\[ {10}\]/,
  );
  assert.doesNotMatch(wideHeader, /snapshot/);

  harness.terminal.columns = 80;
  harness.terminal.rows = 24;
  lines = harness.component.render(80).map((line) => line.trimEnd());
  assert.match(lines[0] ?? "", /^DiffWalk \/ Review · Unit 1\/2$/);
  assert.match(lines[2] ?? "", /0\/2 reviewed · 0 comments · 1 skipped/);
  assert.match(lines.join("\n"), /Does validation preserve compatibility/);

  harness.terminal.columns = 40;
  lines = harness.component.render(40).map((line) => line.trimEnd());
  assert.equal(lines[0], "DiffWalk / Review · 1/2");
  assert.equal(lines[2], "Reviewed 0/2");
  assert.match(lines[3] ?? "", /0 comments · 1 skipped/);

  harness.terminal.columns = 18;
  lines = harness.component.render(18).map((line) => line.trimEnd());
  assert.equal(lines[0], "DiffWalk · 1/2");
  assert.match(lines.slice(2, 7).join("\n"), /Reviewed 0\/2/);
  assert.match(lines.slice(2, 7).join("\n"), /0 comments/);
  assert.match(lines.slice(2, 7).join("\n"), /1 skipped/);
  assert.match(lines.slice(2, 7).join("\n"), /2 unsupported/);
});

test("renders bounded progress with distinct boundary and fill roles", () => {
  const harness = createHarness(120, 30, makeUiFixture(), {
    theme: progressBarTheme,
  });

  press(harness.component, "n");
  assert.ok(
    renderText(harness).includes(
      "\u001b[34m[\u001b[39m\u001b[35m█████\u001b[39m     \u001b[34m]\u001b[39m",
    ),
  );

  press(harness.component, "n");
  assert.ok(
    renderText(harness).includes(
      "\u001b[34m[\u001b[39m\u001b[35m██████████\u001b[39m\u001b[34m]\u001b[39m",
    ),
  );
});

test("drops wide status when the comment editor reserves its body", () => {
  const harness = createHarness(100, 8);

  press(harness.component, "c");
  const output = renderText(harness);

  assert.doesNotMatch(output, /reviewed|comments|skipped|unsupported/);
  assert.match(output, /src\/entry/);
  assert.match(output.split("\n").at(-1) ?? "", /Enter save/);
});

test("keeps core workflow actions in the responsive walkthrough footer", () => {
  const harness = createHarness(80, 18);
  const footerAt = (width: number): string => {
    harness.terminal.columns = width;
    return harness.component.render(width).at(-1)?.trimEnd() ?? "";
  };

  assert.equal(footerAt(40), "c comment • ←/→ unit • n finish • ? help");
  assert.equal(
    footerAt(80),
    "j/k line • ←/→ unit • c comment • n complete • e details • s summary • ? help",
  );
  assert.equal(
    footerAt(120),
    "j/k line • ←/→ unit • c comment • d delete • n complete • e details • i inventory • s summary • Esc pause • ? help",
  );
  assert.equal(footerAt(29), "c comment • n finish • ? help");
  assert.equal(footerAt(18), "c comment • ? help");
});

test("short narrow walkthrough keeps its footer and selected diff line", () => {
  const harness = createHarness(30, 8);

  for (const rows of [4, 5, 8]) {
    harness.terminal.rows = rows;
    harness.component.invalidate();
    const output = renderText(harness);
    assert.match(output.split("\n").at(-1) ?? "", /\?/);
    assert.match(output, />\s+5\s+.*-const value/);
    assert.doesNotMatch(output, /comments|skipped|unsupported/);
  }
});

test("opens full keyboard help and returns without moving the review", () => {
  const harness = createHarness(100, 60);
  press(harness.component, "j", "?");

  const help = renderText(harness);
  assert.match(help, /Keyboard help/);
  assert.match(help, /p\/h\/←\s+Open the previous unit/);
  assert.match(help, /c\s+Add or edit a comment/);
  assert.match(help, /n\s+Mark the current unit reviewed/);
  assert.match(help, /e\s+Open the complete unit details/);
  assert.match(help, /Details: e\/h\/←\/Esc/);
  assert.doesNotMatch(help, /agent explanation|Explanation:/);
  assert.match(help, /1-9 \+ move/);
  assert.match(help, /Summary: Enter/);

  press(harness.component, "?");
  const walkthrough = renderText(harness);
  assert.match(walkthrough, /Unit 1\/2/);
  assert.match(walkthrough, />\s+5\s+\+const value = validate/);
});

test("scrolls keyboard help and returns to the screen that opened it", () => {
  const harness = createHarness(50, 8);
  press(harness.component, "e", "?");
  assert.match(renderText(harness), /Review workflow/);

  press(harness.component, "G");
  assert.match(renderText(harness), /Pause: Esc/);

  press(harness.component, "g", "g");
  assert.match(renderText(harness), /Review workflow/);

  press(harness.component, "\u001b");
  assert.match(renderText(harness), /DiffWalk \/ Details/);
});

test("keeps question marks as text in the comment editor", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "W", "h", "y", "?", "\r");

  assert.deepEqual(
    harness.state.review.comments.map((comment) => comment.body),
    ["Why?"],
  );
  assert.doesNotMatch(renderText(harness), /Keyboard help/);
});

test("renders every component row as one terminal line", () => {
  const harness = createHarness(100, 30);
  const lines = harness.component.render(harness.terminal.columns);

  assert.ok(
    lines.every((line) => !line.includes("\n") && !line.includes("\r")),
  );
});

test("escapes newline and bidi control characters in paths", () => {
  const harness = createHarness(120, 60);

  assert.match(renderText(harness), /src\/entry 文\\nfile\.ts/);
  press(harness.component, "i");
  const inventory = renderText(harness);
  assert.match(inventory, /src\/contract\\u\{202e\}gnp\.ts/);
  assert.equal(inventory.includes("\u202e"), false);
});

test("escapes terminal control sequences in agent and Git text", () => {
  const harness = createHarness(100, 30);
  const walkthrough = renderText(harness);
  assert.match(walkthrough, /context line 0\\x1b\[31m/);

  const replacementHarness = createHarness(
    100,
    30,
    makeInlineDiffFixture([
      " head",
      "-old\u001b[31m",
      "+new\u001b[31m",
      " tail",
    ]),
    { theme: inlineTheme },
  );
  const replacement = renderText(replacementHarness);
  assert.match(replacement, /\\x1b\[31m/);
  assert.equal(replacement.includes(`${String.fromCharCode(27)}[31m`), false);

  press(harness.component, "e");
  const explanation = renderText(harness);
  assert.match(explanation, /\\x1b\[2J/);
  assert.equal(explanation.includes(`${String.fromCharCode(27)}[2J`), false);
});

test("highlights changed words in one-line replacement blocks", () => {
  const harness = createHarness(
    120,
    30,
    makeInlineDiffFixture([
      " head",
      "-  return oldValue",
      "+  return newValue",
      " middle",
      "-  alpha",
      "+  beta",
      " tail",
    ]),
    { theme: inlineTheme },
  );
  const output = renderText(harness);

  assert.match(output, /- {2}return \[\[oldValue\]\]/);
  assert.match(output, /\+ {2}return \[\[newValue\]\]/);
  assert.match(output, /- {2}\[\[alpha\]\]/);
  assert.match(output, /\+ {2}\[\[beta\]\]/);
  assert.doesNotMatch(output, /\[\[\s+/);
});

test("does not guess inline pairings for multi-line replacement blocks", () => {
  const harness = createHarness(
    120,
    30,
    makeInlineDiffFixture([
      " head",
      "-const first = oldFirst",
      "-const second = oldSecond",
      "+const first = newFirst",
      "+const second = newSecond",
      " tail",
    ]),
    { theme: inlineTheme },
  );

  assert.doesNotMatch(renderText(harness), /\[\[/);
});

test("does not word-diff very long untrusted lines", () => {
  const oldLine = `-${"old ".repeat(251)}`;
  const newLine = `+${"new ".repeat(251)}`;
  const harness = createHarness(
    120,
    30,
    makeInlineDiffFixture([" head", oldLine, newLine, " tail"]),
    { theme: inlineTheme },
  );

  assert.doesNotMatch(renderText(harness), /\[\[/);
});

test("never renders beyond terminal width or height with ANSI styling", () => {
  const harness = createHarness(80, 24, makeUiFixture(), {
    theme: ansiTheme,
  });

  for (const [columns, rows] of [
    [1, 1],
    [8, 4],
    [20, 8],
    [40, 12],
    [80, 24],
  ] as const) {
    harness.terminal.columns = columns;
    harness.terminal.rows = rows;
    harness.component.invalidate();
    const lines = harness.component.render(columns);
    assert.equal(lines.length, rows, `${columns}x${rows} did not fill height`);
    for (const line of lines) {
      assert.equal(
        visibleWidth(line),
        columns,
        `${JSON.stringify(line)} did not fill width ${columns}`,
      );
    }
  }
});

test("keeps every wrapped row of the selected diff line visible", () => {
  const harness = createHarness(54, 12);

  press(harness.component, "j");
  const output = renderText(harness);

  assert.match(output, />\s+\d*\s+5\s+\+const value = validate/);
  assert.match(output, /TAIL_END/);
  assert.match(output, /src\/entry 文\\nfile\.ts/);
});

test("pages through a selected line taller than the diff viewport", () => {
  const harness = createHarness(30, 8);
  press(harness.component, "j");

  const firstPage = renderText(harness);
  press(harness.component, "\u001b[6~", "\u001b[6~");
  const laterPage = renderText(harness);

  assert.notEqual(laterPage, firstPage);
  assert.match(laterPage, /TAIL_END/);
});
