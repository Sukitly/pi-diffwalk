import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import type {
  KeybindingsManager as CodingKeybindingsManager,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Terminal,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ReviewSnapshotDriftError } from "../src/git-diff.ts";
import {
  attachReviewRoute,
  createInProgressReview,
  InProgressReviewError,
} from "../src/in-progress-review.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { createReviewSeries } from "../src/review-series.ts";
import {
  GuidedReviewComponent,
  GuidedReviewUiUnavailableError,
  openGuidedReview,
} from "../src/review-ui.ts";
import {
  ReviewRouteValidationError,
  validateReviewRoute,
} from "../src/route-validation.ts";
import type {
  FileChange,
  FileChangeId,
  GuidedReviewResult,
  InProgressReview,
  NoticeId,
  ReviewDelta,
  ReviewRoundId,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewUnitId,
  SubmittedGuidedReviewResult,
} from "../src/types.ts";
import { fileChangeId, makeSnapshot, span } from "./domain-fixtures.ts";

interface UiFixture {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly routeCandidate: ReviewRouteCandidate;
  readonly route: ReviewRoute;
}

type SubmissionVerifier = (
  snapshot: ReviewSnapshot,
  signal: AbortSignal,
) => Promise<void>;

interface HarnessOptions {
  readonly theme?: Pick<Theme, "fg" | "bg" | "bold" | "inverse">;
  readonly verifier?: SubmissionVerifier;
  readonly keybindings?: TuiKeybindingsManager;
}

interface ComponentHarness {
  readonly component: GuidedReviewComponent;
  readonly terminal: FakeTerminal;
  readonly state: { review: InProgressReview };
  readonly submittedModes: ReviewSubmissionMode[];
  readonly completedResults: SubmittedGuidedReviewResult[];
  readonly cancellations: { count: number };
}

class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly kittyProtocolActive = false;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
  }

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

const plainTheme = {
  fg: (_color: ThemeColor, text: string) => text,
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

const ansiTheme = {
  fg: (_color: ThemeColor, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => `\u001b[44m${text}`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

const spanHeaderTheme = {
  fg: (color: ThemeColor, text: string) => {
    if (color === "accent") return `\u001b[35m${text}\u001b[39m`;
    if (color === "muted") return `\u001b[90m${text}\u001b[39m`;
    return text;
  },
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

const inlineTheme = {
  ...plainTheme,
  inverse: (text: string) => `[[${text}]]`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

const cardTheme = {
  ...plainTheme,
  bg: (color: Parameters<Theme["bg"]>[0], text: string) => {
    const code = color === "userMessageBg" ? 24 : 25;
    return `\u001b[48;5;${code}m${text}\u001b[49m`;
  },
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

const metadataOnly: FileChange = {
  id: "file:metadata:script.sh" as FileChangeId,
  source: "tracked",
  status: "mode-changed",
  oldPath: "script.sh",
  newPath: "script.sh",
  oldMode: "100644",
  newMode: "100755",
  gitHeaderLines: ["old mode 100644", "new mode 100755"],
  content: {
    type: "metadata-only",
    gitBodyLines: [],
    unsupportedReason: "This file change has no textual diff hunks.",
  },
};

const addedBinary: FileChange = {
  id: "file:binary:asset.bin" as FileChangeId,
  source: "tracked",
  status: "added",
  newPath: "asset.bin",
  newMode: "100644",
  gitHeaderLines: [],
  content: {
    type: "binary",
    gitBodyLines: ["Binary files differ"],
    unsupportedReason: "Binary content cannot be reviewed line by line.",
  },
};

const deletedBinary: FileChange = {
  id: "file:binary:removed.bin" as FileChangeId,
  source: "tracked",
  status: "deleted",
  oldPath: "removed.bin",
  oldMode: "100644",
  gitHeaderLines: [],
  content: {
    type: "binary",
    gitBodyLines: ["Binary files differ"],
    unsupportedReason: "Binary content cannot be reviewed line by line.",
  },
};

const ENTRY_PATH = "src/entry \u6587\nfile.ts";
const CONTRACT_PATH = "src/contract\u202egnp.ts";
const CARRIED_PATH = "src/carried.ts";
const SKIPPED_PATH = "src/generated.ts";

/** Long added line used to exercise wrapping and horizontal truncation. */
const LONG_ADDED = `+const value = validate(request.value) \u4e2d\u6587 ${"segment ".repeat(12)}TAIL_END`;

function makeUiFixture(): UiFixture {
  const snapshot = makeSnapshot(
    "snapshot-ui",
    [
      {
        path: ENTRY_PATH,
        lines: [
          " context line 0\u001b[31m",
          " context line 1",
          " context line 2",
          " context line 3",
          "-const value = request.value",
          LONG_ADDED,
          " context line 6",
          " context line 7",
          " context line 8",
        ],
      },
      {
        path: CONTRACT_PATH,
        lines: [
          " export interface Contract {",
          "+export interface Contract { value: string }",
          " }",
        ],
      },
      {
        path: CARRIED_PATH,
        lines: [" head", "+export const carried = true", " tail"],
      },
      {
        path: SKIPPED_PATH,
        lines: [" head", "+generated output", " tail"],
      },
    ],
    {
      changes: [metadataOnly, addedBinary, deletedBinary],
      notices: [
        {
          id: brand<NoticeId>("notice:cancelled-layer"),
          type: "cancelled-layer-change",
          filePath: "src/cancelled.ts",
          message:
            "Staged and unstaged changes cancel in the effective worktree.",
        },
      ],
    },
  );

  const baseDelta = computeReviewDelta(snapshot);
  const carriedId = fileChangeId("modified", CARRIED_PATH);
  const delta: ReviewDelta = {
    ...baseDelta,
    lines: baseDelta.lines.map((line) =>
      line.fileChangeId === carriedId
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
        title: "Request entry point\nsecondary heading",
        whyHere:
          "Start at the external contract before following the data flow.\u001b[2J",
        context: "request -> validate -> execute -> response",
        changeSummary:
          "The request path now validates a value before execution.",
        reviewFocus: [
          "Does validation preserve compatibility?",
          "Does the failure path remain explicit?",
        ],
        spans: [span(ENTRY_PATH, { old: [1, 8], new: [1, 8] })],
      },
      {
        title: "Public contract",
        whyHere: "Review the type consumed by the entry point next.",
        context: "entry -> Contract",
        changeSummary: "The public contract now exposes the validated value.",
        reviewFocus: ["Is the type narrow enough?"],
        spans: [span(CONTRACT_PATH, { new: [1, 3] })],
      },
    ],
    skippedSpans: [
      {
        span: span(SKIPPED_PATH, { new: [2, 2] }),
        reason: "Generated output is represented but reviewed at its source.",
      },
    ],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeLongExplanationFixture(): UiFixture {
  const fixture = makeUiFixture();
  const routeCandidate = structuredClone(fixture.routeCandidate);
  const firstUnit = routeCandidate.units[0];
  assert.ok(firstUnit);
  firstUnit.whyHere = Array.from(
    { length: 12 },
    (_, index) => `Explanation line ${index + 1}`,
  ).join("\n");
  return {
    ...fixture,
    routeCandidate,
    route: validateReviewRoute(fixture.snapshot, fixture.delta, routeCandidate),
  };
}

const INLINE_PATH = "src/inline.ts";

function makeInlineDiffFixture(lines: readonly string[]): UiFixture {
  const snapshot = makeSnapshot("snapshot-inline", [
    { path: INLINE_PATH, lines: [...lines] },
  ]);
  const delta = computeReviewDelta(snapshot);
  const change = snapshot.changes[0];
  assert.ok(change);
  assert.equal(change.content.type, "text");
  if (change.content.type !== "text") throw new Error("Expected text change.");
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Inline replacement",
        whyHere: "Review the replacement.",
        context: "old -> new",
        changeSummary: "The implementation changed.",
        reviewFocus: ["Is the replacement correct?"],
        spans: [
          span(INLINE_PATH, {
            old: [1, change.content.oldLineCount],
            new: [1, change.content.newLineCount],
          }),
        ],
      },
    ],
    skippedSpans: [],
  };
  return {
    snapshot,
    delta,
    routeCandidate,
    route: validateReviewRoute(snapshot, delta, routeCandidate),
  };
}

function makeReview(fixture: UiFixture): InProgressReview {
  return makeReviewWithRoute(fixture, fixture.route);
}

function makeReviewWithRoute(
  fixture: UiFixture,
  route: ReviewRoute,
): InProgressReview {
  const series = createReviewSeries({
    repositoryRoot: fixture.snapshot.repositoryRoot,
    sourceBranch: "feature",
    targetRef: fixture.snapshot.comparison.targetRef,
  });
  const created = createInProgressReview({
    series,
    snapshot: fixture.snapshot,
    delta: fixture.delta,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  return attachReviewRoute(created, route, {
    expectedVersion: created.version,
    timestamp: "2026-01-01T00:01:00.000Z",
  });
}

function forgeRoute(
  fixture: UiFixture,
  candidate: ReviewRouteCandidate,
): ReviewRoute {
  return {
    snapshotId: fixture.snapshot.id,
    units: candidate.units.map((unit, index) => ({
      id: brand<ReviewUnitId>(`review-unit:forged-${index}`),
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus: [...unit.reviewFocus],
      spans: unit.spans.map((s) => ({
        ...s,
        fileChangeId: fileChangeId("modified", s.path),
      })),
    })),
    skippedSpans: candidate.skippedSpans.map((skip) => ({
      span: {
        ...skip.span,
        fileChangeId: fileChangeId("modified", skip.span.path),
      },
      reason: skip.reason,
    })),
  } as unknown as ReviewRoute;
}

function unusedSubmit(): Promise<SubmittedGuidedReviewResult> {
  throw new Error("Submission must not run in this test.");
}

function createHarness(
  columns = 80,
  rows = 24,
  fixture: UiFixture = makeUiFixture(),
  options: HarnessOptions = {},
): ComponentHarness {
  const terminal = new FakeTerminal(columns, rows);
  const tui = new TuiMainScreen(terminal, false);
  const state = { review: makeReview(fixture) };
  const submittedModes: ReviewSubmissionMode[] = [];
  const completedResults: SubmittedGuidedReviewResult[] = [];
  const cancellations = { count: 0 };
  const verifier = options.verifier ?? (async () => {});
  const component = new GuidedReviewComponent({
    tui,
    theme: options.theme ?? plainTheme,
    keybindings: options.keybindings ?? createKeybindings(),
    review: state.review,
    route: fixture.route,
    onReviewChange: (review) => {
      state.review = review;
    },
    onSubmit: async (review, signal) => {
      submittedModes.push(review.submissionMode);
      await verifier(review.snapshot, signal);
      signal.throwIfAborted();
      return {
        status: "submitted",
        snapshotId: review.snapshot.id,
        submissionMode: review.submissionMode,
        comments: review.comments,
      };
    },
    onComplete: (result) => completedResults.push(result),
    onPause: () => {
      cancellations.count += 1;
    },
    onDiscard: () => {
      cancellations.count += 1;
    },
  });
  tui.addChild(component);
  tui.setFocus(component);
  return {
    component,
    terminal,
    state,
    submittedModes,
    completedResults,
    cancellations,
  };
}

function createKeybindings(): TuiKeybindingsManager {
  return new TuiKeybindingsManager(TUI_KEYBINDINGS);
}

function renderText(harness: ComponentHarness): string {
  return harness.component.render(harness.terminal.columns).join("\n");
}

function press(component: GuidedReviewComponent, ...keys: string[]): void {
  for (const key of keys) component.handleInput(key);
}

function visitEveryUnit(component: GuidedReviewComponent): void {
  press(component, "n", "n");
}

test("keeps the walkthrough summary concise and full commentary separate", () => {
  const harness = createHarness(100, 30);
  const walkthrough = renderText(harness);

  assert.match(walkthrough, /Review checks/);
  assert.match(walkthrough, /src\/entry 文\\nfile\.ts/);
  assert.doesNotMatch(walkthrough, /Git snapshot diff/);
  assert.match(walkthrough, />\s+5\s+-const value = request\.value/);
  assert.doesNotMatch(walkthrough, /Why this comes next/);

  press(harness.component, "e");
  const explanation = renderText(harness);
  assert.match(explanation, /DiffWalk \/ Details/);
  assert.match(explanation, /Why this comes next/);
  assert.match(explanation, /Context to keep in mind/);
  assert.match(explanation, /Review checks/);
  assert.doesNotMatch(explanation, /src\/entry 文\\nfile\.ts/);
});

test("groups responsive header information by priority", () => {
  const harness = createHarness(120, 30);

  let lines = harness.component.render(120).map((line) => line.trimEnd());
  assert.match(lines[0] ?? "", /^DiffWalk \/ Review.*Unit 1\/2$/);
  assert.match(lines[1] ?? "", /Request entry point/);
  assert.match(lines[2] ?? "", /0\/2 reviewed.*0 comments.*1 skipped/);
  assert.doesNotMatch(lines.slice(0, 3).join("\n"), /snapshot/);

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

test("opens full keyboard help and returns without moving the review", () => {
  const harness = createHarness(100, 60);
  press(harness.component, "j", "?");

  const help = renderText(harness);
  assert.match(help, /Keyboard help/);
  assert.match(help, /p\/h\/←\s+Open the previous unit/);
  assert.match(help, /c\s+Add or edit a comment/);
  assert.match(help, /n\s+Mark the current unit reviewed/);
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
        reviewFocus: ["Is the surrounding code still correct?"],
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
        reviewFocus: ["Is it correct?"],
        spans: [span("src/pad.ts", { new: [4, 4] })],
      },
      {
        title: "First change",
        whyHere: "Reviewed separately.",
        context: "pad",
        changeSummary: "Adds the first line.",
        reviewFocus: ["Is it correct?"],
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

/** One unit whose span holds two changed lines separated by a long context run. */
function makeContextGapFixture(contextLines = 30): UiFixture {
  const snapshot = makeSnapshot("snapshot-context-gap", [
    {
      path: "src/gap.ts",
      lines: [
        "+first edit",
        ...Array.from(
          { length: contextLines },
          (_, index) => ` filler ${index + 1}`,
        ),
        "+second edit",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Gap unit",
        whyHere: "Both edits are read together with the code between them.",
        context: "gap",
        changeSummary: "Edits the region boundaries.",
        reviewFocus: ["Is the region between the edits still consistent?"],
        spans: [span("src/gap.ts", { new: [1, contextLines + 2] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeSplitSameFileFixture(contextLines: number): UiFixture {
  const snapshot = makeSnapshot("snapshot-split-same-file", [
    {
      path: "src/gap.ts",
      lines: [
        "+first edit",
        ...Array.from(
          { length: contextLines },
          (_, index) => ` filler ${index + 1}`,
        ),
        "+second edit",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Split file unit",
        whyHere: "Both edits belong to one file-level behavior.",
        context: "first -> second",
        changeSummary: "Edits two regions of one file.",
        reviewFocus: ["Can either edit disagree with the shared behavior?"],
        spans: [
          span("src/gap.ts", { new: [1, 1] }),
          span("src/gap.ts", { new: [contextLines + 2, contextLines + 2] }),
        ],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeMixedSideOverlapFixture(): UiFixture {
  const path = "src/mixed-overlap.ts";
  const snapshot = makeSnapshot("snapshot-mixed-overlap", [
    {
      path,
      lines: [
        " before",
        "+early target",
        "+carried one",
        "+carried two",
        "+later target",
        " replacement context",
        "-carried removed",
        "-old target",
        "+final target",
        " after",
      ],
    },
  ]);
  const baseDelta = computeReviewDelta(snapshot);
  const changeId = fileChangeId("modified", path);
  const delta: ReviewDelta = {
    ...baseDelta,
    lines: baseDelta.lines.map((line) =>
      line.fileChangeId === changeId &&
      ((line.side === "new" && (line.line === 3 || line.line === 4)) ||
        (line.side === "old" && line.line === 3))
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
        title: "Mixed-side overlap",
        whyHere: "The replacement must be reviewed in frozen diff order.",
        context: "early -> replacement -> final",
        changeSummary: "Updates both sides of one replacement block.",
        reviewFocus: ["Can the replacement retain the removed behavior?"],
        spans: [
          span(path, { old: [4, 4] }),
          span(path, { new: [2, 2] }),
          span(path, { new: [5, 7] }),
        ],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeSkippedInsideSpanFixture(): UiFixture {
  const path = "src/skipped-inside.ts";
  const snapshot = makeSnapshot("snapshot-skipped-inside", [
    {
      path,
      lines: [
        " before",
        "+target start",
        " replacement context",
        "-generated removed",
        "+target end",
        " after",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Visible replacement",
        whyHere: "The replacement is reviewed before its generated input.",
        context: "start -> generated input -> end",
        changeSummary: "Updates both selectable sides of the replacement.",
        reviewFocus: ["Can the generated removal alter the replacement?"],
        spans: [span(path, { new: [2, 4] })],
      },
    ],
    skippedSpans: [
      {
        span: span(path, { old: [3, 3] }),
        reason: "Generated output is reviewed at its source.",
      },
    ],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeOtherUnitInsideSpanFixture(): UiFixture {
  const path = "src/other-unit-inside.ts";
  const snapshot = makeSnapshot("snapshot-other-unit-inside", [
    {
      path,
      lines: [
        " before",
        "+outer start",
        " replacement context",
        "-inner removal",
        "+outer end",
        " after",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Outer behavior",
        whyHere: "Review the added behavior before the removed fallback.",
        context: "outer start -> fallback -> outer end",
        changeSummary: "Adds the replacement behavior.",
        reviewFocus: ["Can the added behavior bypass the fallback contract?"],
        spans: [span(path, { new: [2, 4] })],
      },
      {
        title: "Fallback removal",
        whyHere: "Review the removed fallback after its replacement.",
        context: "outer behavior -> removed fallback",
        changeSummary: "Removes the old fallback.",
        reviewFocus: ["Can callers still depend on the removed fallback?"],
        spans: [span(path, { old: [3, 3] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

function makeInterleavedFileRouteFixture(): UiFixture {
  const snapshot = makeSnapshot("snapshot-interleaved-files", [
    {
      path: "src/b.ts",
      lines: [" head", "+caller", " middle", "+return"],
    },
    { path: "src/a.ts", lines: [" head", "+callee"] },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Caller, callee, and return",
        whyHere: "Follow the call path in execution order.",
        context: "caller -> callee -> return",
        changeSummary: "Updates all three stages of the call path.",
        reviewFocus: [
          "Can the callee return a value the caller cannot handle?",
        ],
        spans: [
          span("src/b.ts", { new: [2, 2] }),
          span("src/a.ts", { new: [2, 2] }),
          span("src/b.ts", { new: [4, 4] }),
        ],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

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

  for (let index = 0; index < 12; index += 1) {
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
  assert.match(renderText(harness), /Review checks/);
});

test("uses the embedded Editor for multiline Chinese comments with IME focus", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c");
  assert.match(renderText(harness), /Review comment/);
  assert.ok(renderText(harness).includes(CURSOR_MARKER));

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
  assert.match(renderText(harness), /Review checks/);
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

test("pages the complete explanation by its current viewport", () => {
  const harness = createHarness(50, 8, makeLongExplanationFixture());
  press(harness.component, "e");
  const firstPage = renderText(harness);

  press(harness.component, "\u001b[6~");
  const secondPage = renderText(harness);

  assert.notEqual(secondPage, firstPage);
  assert.match(secondPage, /Explanation line [3-9]/);
});

test("pages inventory diffs by the current viewport", () => {
  const harness = createHarness(60, 8);
  press(harness.component, "i", "\r");
  assert.match(renderText(harness), /context line 1/);

  press(harness.component, "\u001b[6~");
  const secondPage = renderText(harness);
  assert.match(secondPage, /context line [2-6]/);
});

/** One review unit covering tall all-added files, for scroll tests. */
function makeTallFixture(
  files: readonly { readonly path: string; readonly count: number }[],
): UiFixture {
  const snapshot = makeSnapshot(
    "snapshot-tall",
    files.map((file) => ({
      path: file.path,
      lines: Array.from(
        { length: file.count },
        (_, index) => `+line ${index + 1}`,
      ),
    })),
  );
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Tall unit",
        whyHere: "Scrolling exercises the pinned file header.",
        context: "tall",
        changeSummary: "Adds many lines.",
        reviewFocus: ["Is every line correct?"],
        spans: files.map((file) => span(file.path, { new: [1, file.count] })),
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

test("restores leading span padding when scrolling back to the first line", () => {
  const snapshot = makeSnapshot("snapshot-margin", [
    {
      path: "src/margin.ts",
      lines: [
        " head 1",
        " head 2",
        " head 3",
        ...Array.from({ length: 25 }, (_, index) => `+line ${index + 1}`),
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Margin unit",
        whyHere: "Scrolling away and back exercises the scroll margin.",
        context: "margin",
        changeSummary: "Adds many lines below unchanged padding.",
        reviewFocus: ["Does the padding stay reachable?"],
        spans: [span("src/margin.ts", { new: [4, 28] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(60, 20, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  assert.match(renderText(harness), /head 1/);

  press(harness.component, ...Array.from({ length: 15 }, () => "j"));
  const scrolled = renderText(harness);
  assert.doesNotMatch(scrolled, /head [1-3]/);

  press(harness.component, ...Array.from({ length: 15 }, () => "k"));
  const returned = renderText(harness);
  assert.match(returned, />\s+4 \+line 1\s/);
  assert.match(returned, /head 1/);
  assert.match(returned, /head 2/);
  assert.match(returned, /head 3/);
});

test("shows only the highlighted file name before and after its header pins", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([{ path: "src/sticky.ts", count: 30 }]),
    { theme: spanHeaderTheme },
  );
  const styledFileName = "\u001b[35m\u001b[1msrc/sticky.ts\u001b[22m\u001b[39m";

  const before = harness.component.render(60);
  const inlineHeader = before.find((line) => line.includes("src/sticky.ts"));
  assert.ok(inlineHeader);
  assert.ok(inlineHeader.includes(styledFileName));
  assert.doesNotMatch(inlineHeader, /\b(?:old|new)\b|"/);

  press(harness.component, ...Array.from({ length: 20 }, () => "j"));
  const after = harness.component.render(60);
  const pinnedHeader = after.find((line) => line.includes("src/sticky.ts"));
  assert.ok(pinnedHeader);
  assert.ok(pinnedHeader.includes(styledFileName));
  assert.doesNotMatch(pinnedHeader, /\b(?:old|new)\b|"/);
  assert.equal(
    after.filter((line) => line.includes("src/sticky.ts")).length,
    1,
  );
  assert.match(after.join("\n"), />\s+21 \+line 21/);
});

test("pins only the top span header in a unit that spans several files", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([
      { path: "src/a.ts", count: 20 },
      { path: "src/b.ts", count: 20 },
    ]),
  );

  press(harness.component, ...Array.from({ length: 20 }, () => "j"));
  const bridged = harness.component.render(60);
  const pinnedA = bridged.findIndex((line) => line.includes("src/a.ts"));
  const inlineB = bridged.findIndex((line) => line.includes("src/b.ts"));
  assert.ok(pinnedA >= 0);
  assert.ok(inlineB > pinnedA);

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const atHeader = harness.component.render(60);
  assert.equal(atHeader.filter((line) => line.includes("src/a.ts")).length, 0);
  assert.equal(atHeader.filter((line) => line.includes("src/b.ts")).length, 1);

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const deep = harness.component.render(60);
  assert.equal(deep.filter((line) => line.includes("src/b.ts")).length, 1);
});

test("pins the inventory file title while scrolling the read-only diff", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([{ path: "src/sticky.ts", count: 30 }]),
  );

  press(harness.component, "i", "\r");
  const top = harness.component.render(60);
  assert.equal(top.filter((line) => line.includes("planned:")).length, 1);

  press(harness.component, ...Array.from({ length: 6 }, () => "j"));
  const scrolled = harness.component.render(60);
  assert.match(scrolled[3] ?? "", /planned: "src\/sticky\.ts"/);
  assert.equal(scrolled.filter((line) => line.includes("planned:")).length, 1);

  press(harness.component, ...Array.from({ length: 40 }, () => "j"));
  const bottom = harness.component.render(60);
  assert.match(bottom[3] ?? "", /planned: "src\/sticky\.ts"/);
  assert.match(bottom.join("\n"), /\+line 30/);
});

test("shows planned, carried, skipped, metadata, binary, and notice inventory", () => {
  const harness = createHarness(120, 60);

  press(harness.component, "i");
  const output = renderText(harness);
  assert.match(output, /planned:/);
  assert.match(output, /carried-forward:/);
  assert.match(output, /skipped:/);
  assert.match(output, /Generated output is represented/);
  assert.match(output, /metadata-only: mode-changed:.*script\.sh/);
  assert.match(output, /Mode: 100644 -> 100755/);
  assert.match(output, /binary: added:.*asset\.bin/);
  assert.match(output, /binary: deleted:.*removed\.bin/);
  assert.match(output, /2 unsupported/);
  assert.match(output, /notice:.*cancelled\.ts/);
});

test("opens carried-forward frozen hunks for explicit inspection", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "i", "j", "j", "\r");

  const output = renderText(harness);
  assert.match(output, /carried-forward/);
  assert.match(output, /export const carried = true/);

  press(harness.component, "\u001b");
  assert.match(renderText(harness), /Review inventory/);
});

test("continues the first pending section before submission", async () => {
  const harness = createHarness(100, 40);
  press(harness.component, "s");
  assert.match(renderText(harness), /Review incomplete/);

  press(harness.component, "\r");
  assert.deepEqual(harness.submittedModes, []);
  assert.match(renderText(harness), /Continue reviewing this section/);
  assert.match(renderText(harness), /Unit 1\/2/);

  press(harness.component, "n", "n", "\r");
  assert.deepEqual(harness.submittedModes, ["discuss-first"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("shows the complete batch and selected submission mode", async () => {
  const harness = createHarness(100, 40);
  press(harness.component, "c", "C", "h", "e", "c", "k", "\r", "n", "n");

  let output = renderText(harness);
  assert.match(output, /Comment batch and submission mode/);
  assert.match(output, /> Discuss first/);
  assert.match(output, /Check/);
  assert.match(output, /Explicitly skipped regions/);
  assert.match(output, /Non-text changes and notices/);

  press(harness.component, "\u001b[C");
  output = renderText(harness);
  assert.match(output, /> Apply change requests/);
  press(harness.component, "\r");
  assert.deepEqual(harness.submittedModes, ["apply-change-requests"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("uses the current summary viewport after a terminal resize", () => {
  const harness = createHarness(80, 20);
  visitEveryUnit(harness.component);
  press(harness.component, "s");
  renderText(harness);

  harness.terminal.rows = 8;
  press(harness.component, "\u001b[6~");

  assert.match(renderText(harness), /No comments were added/);
});

test("aborts pending verification and ignores its late result", async () => {
  let resolveVerification: (() => void) | undefined;
  let verifierSignal: AbortSignal | undefined;
  const harness = createHarness(80, 24, makeUiFixture(), {
    verifier: async (_snapshot, signal) => {
      verifierSignal = signal;
      await new Promise<void>((resolve) => {
        resolveVerification = resolve;
      });
    },
  });
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "n", "n", "\r");
  assert.match(renderText(harness), /Snapshot check in progress/);
  assert.match(renderText(harness), /Checking the frozen snapshot/);

  press(harness.component, "\u001b");
  assert.equal(verifierSignal?.aborted, true);
  assert.match(renderText(harness), /Leave DiffWalk/);
  press(harness.component, "\u001b");
  assert.match(renderText(harness), /verification was cancelled/);

  resolveVerification?.();
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 0);
  assert.equal(harness.state.review.comments[0]?.body, "Draft");
});

test("pauses explicitly without discarding drafts", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "\u001b");

  assert.match(renderText(harness), /Leave DiffWalk/);
  assert.match(renderText(harness), /Pause to keep 1 draft comment/);
  press(harness.component, "\u001b");
  assert.equal(harness.cancellations.count, 0);
  assert.match(renderText(harness), /Review checks/);

  press(harness.component, "\u001b", "\r");
  assert.equal(harness.cancellations.count, 1);
});

test("supports an empty walkthrough when no hunk requires review", async () => {
  const snapshot = makeSnapshot("snapshot-empty-ui", []);
  const delta: ReviewDelta = {
    currentSnapshotId: snapshot.id,
    lines: [],
    removedLineCount: 0,
  };
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(80, 12, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  assert.match(renderText(harness), /No review units were planned/);
  press(harness.component, "s", "\r");
  assert.deepEqual(harness.submittedModes, ["discuss-first"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("validates missing route coverage before opening custom UI", async () => {
  const fixture = makeUiFixture();
  const candidate = structuredClone(fixture.routeCandidate);
  candidate.units.splice(1, 1);
  const review = makeReviewWithRoute(fixture, forgeRoute(fixture, candidate));
  let customCalls = 0;
  const custom: ExtensionContext["ui"]["custom"] = async () => {
    customCalls += 1;
    throw new Error("custom UI must not open");
  };

  await assert.rejects(
    openGuidedReview(
      { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
      { review, onReviewChange: () => {}, onSubmit: unusedSubmit },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRouteValidationError);
      assert.ok(
        error.issues.some((issue) => issue.code === "missing-coverage"),
      );
      return true;
    },
  );
  assert.equal(customCalls, 0);
});

test("rejects carried-forward route references before opening custom UI", async () => {
  const fixture = makeUiFixture();
  const candidate = structuredClone(fixture.routeCandidate);
  const firstUnit = candidate.units[0];
  assert.ok(firstUnit);
  firstUnit.spans.push(span(CARRIED_PATH, { new: [2, 2] }));
  const review = makeReviewWithRoute(fixture, forgeRoute(fixture, candidate));
  let customCalls = 0;
  const custom: ExtensionContext["ui"]["custom"] = async () => {
    customCalls += 1;
    throw new Error("custom UI must not open");
  };

  await assert.rejects(
    openGuidedReview(
      { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
      { review, onReviewChange: () => {}, onSubmit: unusedSubmit },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRouteValidationError);
      assert.ok(
        error.issues.some(
          (issue) => issue.code === "carried-forward-reference",
        ),
      );
      return true;
    },
  );
  assert.equal(customCalls, 0);
});

test("opens a full-screen overlay and submits through one domain pipeline", async () => {
  const fixture = makeUiFixture();
  const terminal = new FakeTerminal(80, 24);
  const tui = new TuiMainScreen(terminal, false);
  let submittedReview: InProgressReview | undefined;
  let submittedSignal: AbortSignal | undefined;
  let customOptions: Parameters<ExtensionContext["ui"]["custom"]>[1];
  const custom: ExtensionContext["ui"]["custom"] = async <Result>(
    factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
    options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
  ): Promise<Result> => {
    customOptions = options;
    return new Promise<Result>((resolve, reject) => {
      void Promise.resolve(
        factory(
          tui,
          plainTheme as Theme,
          createKeybindings() as unknown as CodingKeybindingsManager,
          (result: unknown) => resolve(result as Result),
        ),
      ).then((component) => {
        tui.addChild(component);
        tui.setFocus(component);
        component.handleInput?.("n");
        component.handleInput?.("n");
        component.handleInput?.("\r");
      }, reject);
    });
  };

  const result = await openGuidedReview(
    { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
    {
      review: makeReview(fixture),
      onReviewChange: () => {},
      onSubmit: async (review, signal) => {
        submittedReview = review;
        submittedSignal = signal;
        return {
          status: "submitted",
          snapshotId: review.snapshot.id,
          submissionMode: review.submissionMode,
          comments: review.comments,
        };
      },
    },
  );

  assert.equal(submittedReview?.snapshot.id, fixture.snapshot.id);
  assert.deepEqual(
    submittedReview?.unitProgress.map((progress) => progress.disposition),
    ["reviewed", "reviewed"],
  );
  assert.equal(submittedSignal?.aborted, false);
  assert.deepEqual(customOptions, {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
      margin: 0,
    },
  });
  assert.equal(result.status, "submitted");
});

async function openWithSubmissionFailure(error: Error): Promise<{
  readonly output: string;
  readonly outputAfterModeChange: string;
  readonly result: GuidedReviewResult;
}> {
  const fixture = makeUiFixture();
  const terminal = new FakeTerminal(100, 30);
  const tui = new TuiMainScreen(terminal, false);
  let settled = false;
  let output = "";
  let outputAfterModeChange = "";
  const custom: ExtensionContext["ui"]["custom"] = async <Result>(
    factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
  ) =>
    new Promise<Result>((resolve, reject) => {
      void Promise.resolve(
        factory(
          tui,
          plainTheme as Theme,
          createKeybindings() as unknown as CodingKeybindingsManager,
          (result: unknown) => resolve(result as Result),
        ),
      ).then((component) => {
        tui.addChild(component);
        tui.setFocus(component);
        for (const key of [
          "c",
          "D",
          "r",
          "a",
          "f",
          "t",
          "\r",
          "n",
          "n",
          "\r",
        ]) {
          component.handleInput?.(key);
        }
        void waitForImmediate().then(() => {
          assert.equal(settled, false);
          output = component.render(terminal.columns).join("\n");
          component.handleInput?.("\u001b[6~");
          component.handleInput?.("\u001b[C");
          outputAfterModeChange = component.render(terminal.columns).join("\n");
          component.handleInput?.("\u001b");
          component.handleInput?.("\u001b");
          component.handleInput?.("\r");
        });
      }, reject);
    });
  const review = openGuidedReview(
    { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
    {
      review: makeReview(fixture),
      onReviewChange: () => {},
      onSubmit: async () => {
        throw error;
      },
    },
  );
  void review.then(() => {
    settled = true;
  });
  const result = await review;
  return { output, outputAfterModeChange, result };
}

test("keeps repository drift in the UI with drafts preserved", async () => {
  const failure = await openWithSubmissionFailure(
    new ReviewSnapshotDriftError("repository changed"),
  );

  assert.match(failure.output, /Snapshot changed; submission is blocked/);
  assert.match(failure.output, /Repository drift blocks submission/);
  assert.match(failure.output, /repository changed/);
  assert.match(failure.output, /Draft/);
  assert.match(
    failure.outputAfterModeChange,
    /Repository drift blocks submission/,
  );
  assert.equal(failure.result.status, "paused");
});

test("keeps domain drift rejections in the UI with drafts preserved", async () => {
  const failure = await openWithSubmissionFailure(
    new InProgressReviewError(
      "repository-drifted",
      "Repository state no longer matches review snapshot snapshot-ui.",
    ),
  );

  assert.match(failure.output, /Repository drift blocks submission/);
  assert.match(failure.output, /no longer matches review snapshot/);
  assert.match(failure.output, /Draft/);
  assert.equal(failure.result.status, "paused");
});

test("keeps generic verification failures distinct from drift", async () => {
  const failure = await openWithSubmissionFailure(
    new Error("git executable unavailable"),
  );

  assert.match(failure.output, /Snapshot check failed; submission is blocked/);
  assert.match(failure.output, /Snapshot verification failed/);
  assert.match(failure.output, /git executable unavailable/);
  assert.doesNotMatch(failure.output, /Repository drift blocks submission/);
  assert.match(failure.outputAfterModeChange, /Snapshot verification failed/);
  assert.equal(failure.result.status, "paused");
});

test("fails clearly before opening custom UI outside TUI mode", async () => {
  const fixture = makeUiFixture();
  const ui = {} as ExtensionContext["ui"];

  await assert.rejects(
    openGuidedReview(
      { mode: "print", ui },
      {
        review: makeReview(fixture),
        onReviewChange: () => {},
        onSubmit: unusedSubmit,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GuidedReviewUiUnavailableError);
      assert.match(error.message, /current mode is print/);
      return true;
    },
  );
});

function brand<Value extends string>(value: string): Value {
  return value as Value;
}
