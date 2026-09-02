import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import type {
  KeybindingsManager as CodingKeybindingsManager,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Terminal,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  attachReviewRoute,
  createInProgressReview,
} from "../../src/review/in-progress.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import { createReviewSeries } from "../../src/review/series.ts";
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
} from "../../src/review/types.ts";
import { GuidedReviewComponent } from "../../src/review-ui/component.ts";
import { openGuidedReview } from "../../src/review-ui/index.ts";
import {
  fileChangeId,
  makeSnapshot,
  span,
} from "../support/domain-fixtures.ts";

export interface UiFixture {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly routeCandidate: ReviewRouteCandidate;
  readonly route: ReviewRoute;
}

export type SubmissionVerifier = (
  snapshot: ReviewSnapshot,
  signal: AbortSignal,
) => Promise<void>;

export interface HarnessOptions {
  readonly theme?: Pick<Theme, "fg" | "bg" | "bold" | "inverse">;
  readonly verifier?: SubmissionVerifier;
  readonly keybindings?: TuiKeybindingsManager;
}

export interface ComponentHarness {
  readonly component: GuidedReviewComponent;
  readonly terminal: FakeTerminal;
  readonly state: { review: InProgressReview };
  readonly submittedModes: ReviewSubmissionMode[];
  readonly completedResults: SubmittedGuidedReviewResult[];
  readonly cancellations: { count: number };
}

export class FakeTerminal implements Terminal {
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

export const plainTheme = {
  fg: (_color: ThemeColor, text: string) => text,
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const ansiTheme = {
  fg: (_color: ThemeColor, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => `\u001b[44m${text}`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const progressBarTheme = {
  ...plainTheme,
  fg: (color: ThemeColor, text: string) => {
    if (color === "border") return `\u001b[34m${text}\u001b[39m`;
    if (color === "accent") return `\u001b[35m${text}\u001b[39m`;
    if (color === "muted") return `\u001b[90m${text}\u001b[39m`;
    if (color === "borderMuted") return `\u001b[36m${text}\u001b[39m`;
    return text;
  },
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const spanHeaderTheme = {
  fg: (color: ThemeColor, text: string) => {
    if (color === "accent") return `\u001b[35m${text}\u001b[39m`;
    if (color === "muted") return `\u001b[90m${text}\u001b[39m`;
    return text;
  },
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const hierarchyTheme = {
  fg: (color: ThemeColor, text: string) => {
    if (color === "text") return `\u001b[37m${text}\u001b[39m`;
    if (color === "accent") return `\u001b[35m${text}\u001b[39m`;
    if (color === "muted") return `\u001b[90m${text}\u001b[39m`;
    if (color === "borderMuted") return `\u001b[36m${text}\u001b[39m`;
    return text;
  },
  bg: (_color: Parameters<Theme["bg"]>[0], text: string) => text,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const inlineTheme = {
  ...plainTheme,
  inverse: (text: string) => `[[${text}]]`,
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const cardTheme = {
  ...plainTheme,
  bg: (color: Parameters<Theme["bg"]>[0], text: string) => {
    const code = color === "userMessageBg" ? 24 : 25;
    return `\u001b[48;5;${code}m${text}\u001b[49m`;
  },
} satisfies Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

export const metadataOnly: FileChange = {
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

export const addedBinary: FileChange = {
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

export const deletedBinary: FileChange = {
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

export const ENTRY_PATH = "src/entry \u6587\nfile.ts";
export const CONTRACT_PATH = "src/contract\u202egnp.ts";
export const CARRIED_PATH = "src/carried.ts";
export const SKIPPED_PATH = "src/generated.ts";

/** Long added line used to exercise wrapping and horizontal truncation. */
export const LONG_ADDED = `+const value = validate(request.value) \u4e2d\u6587 ${"segment ".repeat(12)}TAIL_END`;

export function makeUiFixture(): UiFixture {
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
          {
            question: "Does validation preserve compatibility?",
            anchor: { path: ENTRY_PATH, side: "new", line: 5 },
          },
          { question: "Does the failure path remain explicit?" },
        ],
        spans: [span(ENTRY_PATH, { old: [1, 8], new: [1, 8] })],
      },
      {
        title: "Public contract",
        whyHere: "Review the type consumed by the entry point next.",
        context: "entry -> Contract",
        changeSummary: "The public contract now exposes the validated value.",
        reviewFocus: [{ question: "Is the type narrow enough?" }],
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

export function makeLongExplanationFixture(): UiFixture {
  const fixture = makeUiFixture();
  const routeCandidate = structuredClone(fixture.routeCandidate);
  const firstUnit = routeCandidate.units[0];
  assert.ok(firstUnit);
  firstUnit.whyHere = Array.from(
    { length: 20 },
    (_, index) => `Explanation line ${index + 1}`,
  ).join("\n");
  return {
    ...fixture,
    routeCandidate,
    route: validateReviewRoute(fixture.snapshot, fixture.delta, routeCandidate),
  };
}

export function makeLongSummaryFixture(): UiFixture {
  const fixture = makeUiFixture();
  const routeCandidate = structuredClone(fixture.routeCandidate);
  const firstUnit = routeCandidate.units[0];
  assert.ok(firstUnit);
  firstUnit.changeSummary = Array.from(
    { length: 8 },
    (_, index) =>
      `The boundary change affects downstream behavior ${index + 1}.`,
  ).join(" ");
  return {
    ...fixture,
    routeCandidate,
    route: validateReviewRoute(fixture.snapshot, fixture.delta, routeCandidate),
  };
}

export const INLINE_PATH = "src/inline.ts";

export function makeInlineDiffFixture(lines: readonly string[]): UiFixture {
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
        reviewFocus: [{ question: "Is the replacement correct?" }],
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

export function makeReview(fixture: UiFixture): InProgressReview {
  return makeReviewWithRoute(fixture, fixture.route);
}

export function makeReviewWithRoute(
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

export function forgeRoute(
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

export function unusedSubmit(): Promise<SubmittedGuidedReviewResult> {
  throw new Error("Submission must not run in this test.");
}

export function createHarness(
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

export function createKeybindings(): TuiKeybindingsManager {
  return new TuiKeybindingsManager(TUI_KEYBINDINGS);
}

export function renderText(harness: ComponentHarness): string {
  return harness.component.render(harness.terminal.columns).join("\n");
}

export function press(
  component: GuidedReviewComponent,
  ...keys: string[]
): void {
  for (const key of keys) component.handleInput(key);
}

export function visitEveryUnit(component: GuidedReviewComponent): void {
  press(component, "n", "n");
}

/** One unit whose span holds two changed lines separated by a long context run. */
export function makeContextGapFixture(contextLines = 30): UiFixture {
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
        reviewFocus: [
          { question: "Is the region between the edits still consistent?" },
        ],
        spans: [span("src/gap.ts", { new: [1, contextLines + 2] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

export function makeSplitSameFileFixture(contextLines: number): UiFixture {
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
        reviewFocus: [
          { question: "Can either edit disagree with the shared behavior?" },
        ],
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

export function makeMixedSideOverlapFixture(): UiFixture {
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
        reviewFocus: [
          { question: "Can the replacement retain the removed behavior?" },
        ],
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

export function makeSkippedInsideSpanFixture(): UiFixture {
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
        reviewFocus: [
          { question: "Can the generated removal alter the replacement?" },
        ],
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

export function makeOtherUnitInsideSpanFixture(): UiFixture {
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
        reviewFocus: [
          { question: "Can the added behavior bypass the fallback contract?" },
        ],
        spans: [span(path, { new: [2, 4] })],
      },
      {
        title: "Fallback removal",
        whyHere: "Review the removed fallback after its replacement.",
        context: "outer behavior -> removed fallback",
        changeSummary: "Removes the old fallback.",
        reviewFocus: [
          { question: "Can callers still depend on the removed fallback?" },
        ],
        spans: [span(path, { old: [3, 3] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

export function makeInterleavedFileRouteFixture(): UiFixture {
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
          {
            question: "Can the callee return a value the caller cannot handle?",
          },
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

/** One review unit covering tall all-added files, for scroll tests. */
export function makeTallFixture(
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
        reviewFocus: [{ question: "Is every line correct?" }],
        spans: files.map((file) => span(file.path, { new: [1, file.count] })),
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  return { snapshot, delta, routeCandidate, route };
}

export async function openWithSubmissionFailure(error: Error): Promise<{
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

export function brand<Value extends string>(value: string): Value {
  return value as Value;
}
