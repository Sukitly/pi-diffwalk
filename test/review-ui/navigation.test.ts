import assert from "node:assert/strict";
import test from "node:test";
import {
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import type {
  ReviewDelta,
  ReviewRoundId,
  ReviewRouteCandidate,
} from "../../src/review/types.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";
import {
  brand,
  createHarness,
  makeContextGapFixture,
  makeInterleavedFileRouteFixture,
  makeLongExplanationFixture,
  makeMixedSideOverlapFixture,
  makeOtherUnitInsideSpanFixture,
  makeSkippedInsideSpanFixture,
  makeSplitSameFileFixture,
  makeTallFixture,
  makeUiFixture,
  press,
  renderText,
  type UiFixture,
} from "./harness.ts";

test("moves between semantic units and preserves each unit cursor", () => {
  const harness = createHarness(80, 18);
  press(harness.component, "j", "j");

  press(harness.component, "n");
  assert.match(renderText(harness), /Unit 2\/2/);
  assert.match(renderText(harness), /Public contract/);
  assert.match(renderText(harness), /export interface Contract/);

  press(harness.component, "p");
  assert.match(renderText(harness), /Unit 1\/2/);
  press(harness.component, "c");
  assert.match(renderText(harness), /const value = validate\(request\.value\)/);
});

test("pads a narrow span with unchanged context without making it reviewable", () => {
  const snapshot = makeSnapshot("snapshot-pad", [
    {
      path: "src/pad.ts",
      lines: [
        " head 1",
        " head 2",
        " head 3",
        " head 4",
        "+changed",
        " tail 1",
        " tail 2",
        " tail 3",
        " tail 4",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Narrow span",
        whyHere: "The agent framed only the changed line.",
        context: "pad",
        changeSummary: "Adds one line.",
        reviewFocus: [{ question: "Is the surrounding code still correct?" }],
        spans: [span("src/pad.ts", { new: [5, 5] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(80, 24, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  const output = renderText(harness);
  assert.match(output, /head 2/);
  assert.match(output, /tail 3/);
  assert.doesNotMatch(output, /head 1/);
  assert.doesNotMatch(output, /tail 4/);
  assert.match(output, />\s+5\s+\+changed/);

  // Padding is display only: the unit still owns exactly one commentable line.
  press(harness.component, "j", "j", "c", "O", "k", "\r");
  assert.deepEqual(
    harness.state.review.comments.map((comment) => [
      comment.side,
      comment.line,
    ]),
    [["new", 5]],
  );
});

test("stops padding at a changed line owned by another unit", () => {
  const snapshot = makeSnapshot("snapshot-neighbour", [
    {
      path: "src/pad.ts",
      lines: [" head", "+first", " middle", "+second", " tail"],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Second change",
        whyHere: "Reviewed on its own.",
        context: "pad",
        changeSummary: "Adds the second line.",
        reviewFocus: [{ question: "Is it correct?" }],
        spans: [span("src/pad.ts", { new: [4, 4] })],
      },
      {
        title: "First change",
        whyHere: "Reviewed separately.",
        context: "pad",
        changeSummary: "Adds the first line.",
        reviewFocus: [{ question: "Is it correct?" }],
        spans: [span("src/pad.ts", { new: [2, 2] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(80, 24, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  const output = renderText(harness);
  assert.match(output, /middle/);
  assert.match(output, /tail/);
  assert.doesNotMatch(output, /\+first/);
});

test("moves between units with arrow keys without marking them reviewed", () => {
  const harness = createHarness(80, 18);

  press(harness.component, "\u001b[C");
  assert.match(renderText(harness), /Unit 2\/2/);
  assert.match(renderText(harness), /0\/2 reviewed/);

  press(harness.component, "\u001b[D");
  assert.match(renderText(harness), /Unit 1\/2/);

  press(harness.component, "n");
  assert.match(renderText(harness), /1\/2 reviewed/);
});

test("moves between units with h and l without marking them reviewed", () => {
  const harness = createHarness(80, 18);

  press(harness.component, "l");
  assert.match(renderText(harness), /Unit 2\/2/);
  assert.match(renderText(harness), /0\/2 reviewed/);

  press(harness.component, "h");
  assert.match(renderText(harness), /Unit 1\/2/);
});

test("jumps to the first and last commentable line with gg and G", () => {
  const harness = createHarness(80, 18);

  press(harness.component, "G");
  assert.match(
    renderText(harness),
    />\s+5\s+\+const value = validate/,
    "G selects the last commentable line",
  );

  press(harness.component, "g", "g");
  assert.match(
    renderText(harness),
    />\s+5\s+-const value = request\.value/,
    "gg selects the first commentable line",
  );
});

test("a bare g prefix does not swallow the following non-g key", () => {
  const harness = createHarness(80, 18);

  press(harness.component, "g", "j");
  assert.match(
    renderText(harness),
    />\s+5\s+\+const value = validate/,
    "g followed by j is handled as plain j",
  );

  press(harness.component, "g", "e");
  assert.match(renderText(harness), /DiffWalk \/ Details/);
});

test("typing g and digits in the comment editor stays text input", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c", "g", "g", "5", "j", "\r");
  assert.deepEqual(
    harness.state.review.comments.map((comment) => comment.body),
    ["gg5j"],
  );
});

test("applies a count prefix to movement keys", () => {
  const harness = createHarness(
    60,
    24,
    makeTallFixture([{ path: "src/tall.ts", count: 12 }]),
  );

  press(harness.component, "3", "j");
  assert.match(renderText(harness), />\s+4\s+\+line 4/);

  press(harness.component, "1", "0", "j");
  assert.match(
    renderText(harness),
    />\s+12\s+\+line 12/,
    "a multi-digit count clamps at the last line",
  );

  press(harness.component, "2", "k");
  assert.match(renderText(harness), />\s+10\s+\+line 10/);
});

test("clamps a count prefix on unit movement", () => {
  const harness = createHarness(80, 18);

  press(harness.component, "9", "l");
  assert.match(renderText(harness), /Unit 2\/2/);

  press(harness.component, "9", "h");
  assert.match(renderText(harness), /Unit 1\/2/);
});

test("clears a pending count when a non-movement key follows", () => {
  const harness = createHarness(
    60,
    24,
    makeTallFixture([{ path: "src/tall.ts", count: 12 }]),
  );

  press(harness.component, "5", "e");
  assert.match(renderText(harness), /DiffWalk \/ Details/);
  press(harness.component, "h");

  press(harness.component, "j");
  assert.match(
    renderText(harness),
    />\s+2\s+\+line 2/,
    "the count consumed by e does not leak into j",
  );
});

test("scrolls the walkthrough diff by half a viewport with ctrl+d and ctrl+u", () => {
  const harness = createHarness(30, 8);
  press(harness.component, "j");
  const firstPage = renderText(harness);

  press(harness.component, "\u0004");
  const halfPage = renderText(harness);
  assert.notEqual(halfPage, firstPage);

  press(harness.component, "\u0015");
  assert.equal(renderText(harness), firstPage);

  press(harness.component, "g", "g");
  assert.match(renderText(harness), />\s+5\s+-const value/);
});

test("pages details by the rendered viewport without skipping lines", () => {
  const harness = createHarness(40, 8, makeLongExplanationFixture());
  const numbers = (output: string): number[] =>
    [...output.matchAll(/Explanation line (\d+)/g)].map((match) =>
      Number(match[1]),
    );

  press(harness.component, "e");
  const firstPage = numbers(renderText(harness));
  press(harness.component, "\u001b[6~");
  const secondPage = numbers(renderText(harness));

  assert.ok(firstPage.length > 0);
  assert.ok(secondPage.length > 0);
  assert.equal(secondPage[0], (firstPage.at(-1) ?? 0) + 1);
});

test("scrolls the explanation with vim keys", () => {
  const harness = createHarness(50, 8, makeLongExplanationFixture());
  press(harness.component, "e");
  const firstPage = renderText(harness);

  press(harness.component, "G");
  const lastPage = renderText(harness);
  assert.notEqual(lastPage, firstPage);
  assert.match(lastPage, /Does the failure path remain explicit\?/);

  press(harness.component, "g", "g");
  assert.equal(renderText(harness), firstPage);

  press(harness.component, "\u0004");
  assert.notEqual(renderText(harness), firstPage);
  press(harness.component, "\u0015");
  assert.equal(renderText(harness), firstPage);

  press(harness.component, "\u0006");
  assert.notEqual(renderText(harness), firstPage);
  press(harness.component, "\u0002");
  assert.equal(renderText(harness), firstPage);

  press(harness.component, "h");
  assert.match(renderText(harness), /request\.value/);
});

test("groups nearby spans from one file under one header without duplicate context", () => {
  const harness = createHarness(80, 30, makeSplitSameFileFixture(3));
  const output = renderText(harness);

  assert.equal(output.match(/src\/gap\.ts/g)?.length, 1);
  assert.equal(output.match(/filler \d/g)?.length, 3);
  assert.doesNotMatch(output, /frozen diff lines not shown/);
  assert.match(output, /\+first edit[\s\S]*\+second edit/);
});

test("preserves route target order while deduplicating mixed-side overlap", () => {
  const harness = createHarness(100, 30, makeMixedSideOverlapFixture());
  let output = renderText(harness);

  assert.equal(output.match(/-old target/g)?.length, 1);
  assert.match(
    output,
    />\s+4\s+-old target[\s\S]*routed region continues elsewhere[\s\S]*\+early target[\s\S]*\+later target[\s\S]*already shown earlier[\s\S]*\+final target/,
  );

  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+2\s+\+early target/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+5\s+\+later target/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+7\s+\+final target/);
});

test("classifies carried-forward gaps and keeps in-span carried lines visible", () => {
  const harness = createHarness(100, 30, makeMixedSideOverlapFixture());
  const output = renderText(harness);

  assert.match(
    output,
    /\+early target[\s\S]*2 frozen diff lines not shown; reviewed in an earlier round[\s\S]*\+later target/,
  );
  assert.doesNotMatch(output, /carried one|carried two/);
  assert.match(
    output,
    /Reviewed in an earlier round; these changed lines are not selectable here\.[\s\S]*·\s+3\s+-carried removed/,
  );
  assert.match(output, /1 frozen diff line already shown earlier in this unit/);
});

test("keeps explicitly skipped in-span lines visible with their reason", () => {
  const harness = createHarness(120, 30, makeSkippedInsideSpanFixture());
  let output = renderText(harness);

  assert.match(
    output,
    /\+target start[\s\S]*Skipped from the walkthrough: Generated output is reviewed at its source\.[\s\S]*·\s+3\s+-generated removed[\s\S]*\+target end/,
  );
  assert.match(output, />\s+2\s+\+target start/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+4\s+\+target end/);
});

test("keeps other-unit in-span lines visible but non-selectable", () => {
  const harness = createHarness(120, 30, makeOtherUnitInsideSpanFixture());
  let output = renderText(harness);

  assert.match(
    output,
    /Routed to review unit "Fallback removal"; these changed lines are not selectable here\.[\s\S]*·\s+3\s+-inner removal/,
  );
  assert.match(output, />\s+2\s+\+outer start/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+4\s+\+outer end/);

  press(harness.component, "l");
  output = renderText(harness);
  assert.match(output, /Fallback removal/);
  assert.match(output, />\s+3\s+-inner removal/);
});

test("preserves interleaved route blocks and navigation across files", () => {
  const harness = createHarness(120, 40, makeInterleavedFileRouteFixture());
  let output = renderText(harness);

  assert.equal(output.match(/src\/b\.ts/g)?.length, 2);
  assert.match(
    output,
    /src\/b\.ts[\s\S]*\+caller[\s\S]*src\/a\.ts[\s\S]*\+callee[\s\S]*src\/b\.ts[\s\S]*\+return/,
  );
  assert.match(output, />\s+2\s+\+caller/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+2\s+\+callee/);
  press(harness.component, "j");
  output = renderText(harness);
  assert.match(output, />\s+4\s+\+return/);
});

test("collapses a long mixed gap into one omission row with counts", () => {
  const path = "src/long-gap.ts";
  const lines = [" head", "+first edit"];
  for (let index = 0; index < 6; index += 1) {
    lines.push(` filler ${index}`, `+carried ${index}`);
  }
  lines.push(" tail context", "+second edit", " tail");
  const snapshot = makeSnapshot("snapshot-long-gap", [{ path, lines }]);
  const baseDelta = computeReviewDelta(snapshot);
  const changeId = fileChangeId("modified", path);
  const delta: ReviewDelta = {
    ...baseDelta,
    lines: baseDelta.lines.map((line) =>
      line.fileChangeId === changeId && line.line > 2 && line.line < 15
        ? {
            type: "carried-forward",
            fileChangeId: line.fileChangeId,
            side: line.side,
            line: line.line,
            reviewedInRoundId: brand<ReviewRoundId>("round:previous"),
          }
        : line,
    ),
  };
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Both edits",
        whyHere: "They belong together.",
        context: "first -> second",
        changeSummary: "Edits both ends.",
        reviewFocus: [{ question: "Do the ends agree?" }],
        spans: [span(path, { new: [2, 2] }), span(path, { new: [16, 16] })],
      },
    ],
    skippedSpans: [],
  };
  const fixture: UiFixture = {
    snapshot,
    delta,
    routeCandidate,
    route: validateReviewRoute(snapshot, delta, routeCandidate),
  };
  const output = renderText(createHarness(100, 40, fixture));

  assert.equal(output.match(/not shown/g)?.length, 1);
  assert.match(
    output,
    /\+first edit[\s\S]*⋯ 11 frozen diff lines not shown; 6 reviewed in an earlier round[\s\S]*\+second edit/,
  );
  assert.doesNotMatch(output, /carried 2|carried 3|filler 3/);
});

test("separates distant spans with one omission marker and keeps the file title pinned", () => {
  const harness = createHarness(80, 30, makeSplitSameFileFixture(30));
  const top = renderText(harness);

  assert.equal(top.match(/src\/gap\.ts/g)?.length, 1);
  assert.match(top, /24 frozen diff lines not shown/);

  harness.terminal.rows = 10;
  press(harness.component, "G");
  const bottom = renderText(harness);
  assert.equal(bottom.match(/src\/gap\.ts/g)?.length, 1);
  assert.match(bottom, />\s+32\s+\+second edit/);
});

test("half-page scrolling continues through context without snapping back", () => {
  const harness = createHarness(40, 10, makeContextGapFixture());

  press(harness.component, "\u0004");
  const scrolled = renderText(harness);
  assert.doesNotMatch(scrolled, /\+first edit/, "the viewport left the edit");
  assert.match(scrolled, /filler \d+/);

  press(harness.component, "\u0004");
  const deeper = renderText(harness);
  assert.notEqual(deeper, scrolled, "the second half page keeps scrolling");

  for (let index = 0; index < 20; index += 1) {
    press(harness.component, "\u0004");
  }
  assert.match(
    renderText(harness),
    />\s+32\s+\+second edit/,
    "the next commentable line is selected once it enters the viewport",
  );

  press(harness.component, "g", "g");
  assert.match(
    renderText(harness),
    />\s+1\s+\+first edit/,
    "gg re-anchors the viewport to the selection",
  );
});

test("explanation G lands on a real offset that the next key can leave", () => {
  const harness = createHarness(50, 8, makeLongExplanationFixture());
  press(harness.component, "e", "G");
  const lastPage = renderText(harness);

  press(harness.component, "g", "g", "G", "k");
  const nearEnd = renderText(harness);
  assert.notEqual(nearEnd, lastPage, "k right after G leaves the last page");

  press(harness.component, "j");
  assert.equal(renderText(harness), lastPage);
});

test("inventory diff G lands on a real offset that the next key can leave", () => {
  const harness = createHarness(60, 12);
  press(harness.component, "i", "\r", "G");
  const lastPage = renderText(harness);

  press(harness.component, "g", "g", "G", "k");
  const nearEnd = renderText(harness);
  assert.notEqual(nearEnd, lastPage, "k right after G leaves the last page");

  press(harness.component, "j");
  assert.equal(renderText(harness), lastPage);
});

test("summary G lands on a real offset that the next key can leave", () => {
  const harness = createHarness(50, 8);
  press(harness.component, "s", "G");
  const lastPage = renderText(harness);

  press(harness.component, "g", "g", "G", "k");
  const nearEnd = renderText(harness);
  assert.notEqual(nearEnd, lastPage, "k right after G leaves the last page");

  press(harness.component, "j");
  assert.equal(renderText(harness), lastPage);
});

test("pages the inventory by the rendered viewport", () => {
  const harness = createHarness(120, 13);
  press(harness.component, "i");

  // Every entry renders two rows at this width; the viewport is nine rows,
  // so one page lands on the fifth entry, not a fixed entry count.
  press(harness.component, "\u001b[6~");
  assert.match(renderText(harness), />\s+metadata-only: mode-changed/);

  press(harness.component, "\u001b[5~");
  assert.match(renderText(harness), />\s+planned: "src\/entry/);
});

test("pages the inventory by rendered rows when entries wrap", () => {
  const harness = createHarness(30, 9);
  press(harness.component, "i");

  // Wrapped entries fill the five-row viewport quickly, so one page must
  // advance far fewer entries than the old fixed two-rows-per-entry guess.
  press(harness.component, "\u001b[6~");
  assert.match(renderText(harness), /> planned:\s+"src\/contract/);
});

test("a configured select binding takes precedence over vim prefix keys", () => {
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": ["down", "g"],
  });
  const harness = createHarness(80, 18, makeUiFixture(), { keybindings });

  press(harness.component, "g");
  assert.match(
    renderText(harness),
    />\s+5\s+\+const value = validate/,
    "g bound to tui.select.down moves the selection instead of arming gg",
  );
});

test("navigates the inventory with vim keys", () => {
  const harness = createHarness(120, 60);
  press(harness.component, "i");

  press(harness.component, "G");
  assert.match(renderText(harness), />\s+notice: "src\/cancelled\.ts"/);

  press(harness.component, "g", "g");
  assert.match(renderText(harness), />\s+planned: "src\/entry/);

  press(harness.component, "l");
  assert.match(renderText(harness), /context line 1/);

  press(harness.component, "h");
  assert.match(renderText(harness), /Review inventory/);
  press(harness.component, "h");
  assert.match(renderText(harness), /DiffWalk \/ Review/);
});
