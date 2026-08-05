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
  TUI,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
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
  readonly theme?: Pick<Theme, "fg" | "bg" | "bold">;
  readonly verifier?: SubmissionVerifier;
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
} satisfies Pick<Theme, "fg" | "bg" | "bold">;

const ansiTheme = {
  fg: (_color: ThemeColor, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => `\u001b[44m${text}`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold">;

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
  const tui = new TUI(terminal, false);
  const state = { review: makeReview(fixture) };
  const submittedModes: ReviewSubmissionMode[] = [];
  const completedResults: SubmittedGuidedReviewResult[] = [];
  const cancellations = { count: 0 };
  const verifier = options.verifier ?? (async () => {});
  const component = new GuidedReviewComponent({
    tui,
    theme: options.theme ?? plainTheme,
    keybindings: createKeybindings(),
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

  assert.match(walkthrough, /Review this change/);
  assert.match(walkthrough, /Git snapshot diff/);
  assert.match(walkthrough, />\s+5\s+-const value = request\.value/);
  assert.doesNotMatch(walkthrough, /Why here/);

  press(harness.component, "e");
  const explanation = renderText(harness);
  assert.match(explanation, /Agent explanation/);
  assert.match(explanation, /Why here/);
  assert.doesNotMatch(explanation, /Git snapshot diff/);
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

  press(harness.component, "e");
  const explanation = renderText(harness);
  assert.match(explanation, /\\x1b\[2J/);
  assert.equal(explanation.includes(`${String.fromCharCode(27)}[2J`), false);
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
  assert.match(output, /Git snapshot diff/);
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
  assert.match(renderText(harness), /unit 2\/2/);
  assert.match(renderText(harness), /Public contract/);
  assert.match(renderText(harness), /export interface Contract/);

  press(harness.component, "p");
  assert.match(renderText(harness), /unit 1\/2/);
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
  assert.match(renderText(harness), /unit 2\/2/);
  assert.match(renderText(harness), /reviewed 0\/2/);

  press(harness.component, "\u001b[D");
  assert.match(renderText(harness), /unit 1\/2/);

  press(harness.component, "n");
  assert.match(renderText(harness), /reviewed 1\/2/);
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
  assert.match(renderText(harness), /comments 1/);
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
  assert.match(renderText(harness), /Git snapshot diff/);
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

test("pins the span file header once it scrolls out of the diff viewport", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([{ path: "src/sticky.ts", count: 30 }]),
  );

  const before = harness.component.render(60);
  assert.equal(
    before.filter((line) => line.includes('"src/sticky.ts"')).length,
    1,
  );

  press(harness.component, ...Array.from({ length: 20 }, () => "j"));
  const after = harness.component.render(60);
  const labelIndex = after.findIndex((line) =>
    line.includes("Git snapshot diff"),
  );
  assert.ok(labelIndex >= 0);
  assert.match(after[labelIndex + 1] ?? "", /"src\/sticky\.ts" {2}new 1-30/);
  assert.equal(
    after.filter((line) => line.includes('"src/sticky.ts"')).length,
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
  const bridgedLabel = bridged.findIndex((line) =>
    line.includes("Git snapshot diff"),
  );
  assert.match(bridged[bridgedLabel + 1] ?? "", /"src\/a\.ts"/);
  assert.equal(bridged.filter((line) => line.includes('"src/b.ts"')).length, 1);

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const atHeader = harness.component.render(60);
  assert.equal(
    atHeader.filter((line) => line.includes('"src/a.ts"')).length,
    0,
  );
  assert.equal(
    atHeader.filter((line) => line.includes('"src/b.ts"')).length,
    1,
  );

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const deep = harness.component.render(60);
  const deepLabel = deep.findIndex((line) =>
    line.includes("Git snapshot diff"),
  );
  assert.match(deep[deepLabel + 1] ?? "", /"src\/b\.ts"/);
  assert.equal(deep.filter((line) => line.includes('"src/b.ts"')).length, 1);
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
  assert.match(output, /unsupported 2/);
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
  assert.match(renderText(harness), /unit 1\/2/);

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
  assert.match(renderText(harness), /Git snapshot diff/);

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
  const tui = new TUI(terminal, false);
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
  const tui = new TUI(terminal, false);
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
