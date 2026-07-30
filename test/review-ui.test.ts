import assert from "node:assert/strict";
import test from "node:test";
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
import { ReviewSession } from "../src/review-comments.ts";
import {
  GuidedReviewComponent,
  GuidedReviewUiUnavailableError,
  openGuidedReview,
} from "../src/review-ui.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  DiffLine,
  FileChange,
  FileChangeId,
  HunkId,
  NoticeId,
  ReviewDelta,
  ReviewRoundId,
  ReviewRoute,
  ReviewSnapshot,
  ReviewSubmissionMode,
} from "../src/types.ts";
import { hunkId, makeSnapshot } from "./domain-fixtures.ts";

interface UiFixture {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly route: ReviewRoute;
}

interface ComponentHarness {
  readonly component: GuidedReviewComponent;
  readonly session: ReviewSession;
  readonly terminal: FakeTerminal;
  readonly submittedModes: ReviewSubmissionMode[];
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

function makeUiFixture(): UiFixture {
  const base = makeSnapshot("snapshot-ui", [
    {
      id: "h-entry",
      fingerprint: "fp-entry",
      path: "src/entry 文\nfile.ts",
      start: 10,
      count: 10,
    },
    {
      id: "h-contract",
      fingerprint: "fp-contract",
      path: "src/contract.ts",
      start: 30,
    },
    {
      id: "h-carried",
      fingerprint: "fp-carried",
      path: "src/carried.ts",
      start: 40,
    },
    {
      id: "h-skipped",
      fingerprint: "fp-skipped",
      path: "src/generated.ts",
      start: 50,
    },
  ]);
  const snapshotWithLines = replaceHunkLines(
    base,
    new Map([
      [hunkId("h-entry"), makeEntryLines()],
      [
        hunkId("h-contract"),
        [
          {
            index: 0,
            kind: "added",
            raw: "+export interface Contract { value: string }",
            newLine: 30,
          },
        ],
      ],
      [
        hunkId("h-carried"),
        [
          {
            index: 0,
            kind: "context",
            raw: " export const carried = true",
            oldLine: 40,
            newLine: 40,
          },
        ],
      ],
      [
        hunkId("h-skipped"),
        [
          {
            index: 0,
            kind: "added",
            raw: "+generated output",
            newLine: 50,
          },
        ],
      ],
    ]),
  );
  const unsupported: FileChange = {
    id: brand<FileChangeId>("file:binary:asset.bin"),
    source: "tracked",
    status: "modified",
    oldPath: "asset.bin",
    newPath: "asset.bin",
    oldMode: "100644",
    newMode: "100644",
    gitHeaderLines: [],
    content: {
      kind: "binary",
      gitBodyLines: ["Binary files differ"],
      unsupportedReason: "Binary content cannot be reviewed line by line.",
    },
  };
  const snapshot: ReviewSnapshot = {
    ...snapshotWithLines,
    changes: [...snapshotWithLines.changes, unsupported],
    notices: [
      {
        id: brand<NoticeId>("notice:cancelled-layer"),
        kind: "cancelled-layer-change",
        filePath: "src/cancelled.ts",
        message:
          "Staged and unstaged changes cancel in the effective worktree.",
      },
    ],
  };
  const delta: ReviewDelta = {
    currentSnapshotId: snapshot.id,
    hunks: [
      { type: "needs-review", hunkId: hunkId("h-entry"), reason: "new" },
      {
        type: "needs-review",
        hunkId: hunkId("h-contract"),
        reason: "changed",
      },
      {
        type: "carried-forward",
        hunkId: hunkId("h-carried"),
        reviewedInRoundId: brand<ReviewRoundId>("round:previous"),
      },
      {
        type: "needs-review",
        hunkId: hunkId("h-skipped"),
        reason: "new",
      },
    ],
    removedHunkFingerprints: [],
  };
  const route = validateReviewRoute(snapshot, delta, {
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
        hunkIds: [hunkId("h-entry")],
      },
      {
        title: "Public contract",
        whyHere: "Review the type consumed by the entry point next.",
        context: "entry -> Contract",
        changeSummary: "The public contract now exposes the validated value.",
        reviewFocus: ["Is the type narrow enough?"],
        hunkIds: [hunkId("h-contract")],
      },
    ],
    skippedHunks: [
      {
        hunkId: hunkId("h-skipped"),
        reason: "Generated output is represented but reviewed at its source.",
      },
    ],
  });
  return { snapshot, delta, route };
}

function makeEntryLines(): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  for (let index = 0; index < 10; index += 1) {
    if (index === 4) {
      lines.push({
        index,
        kind: "removed",
        raw: "-const value = request.value",
        oldLine: 14,
      });
    } else if (index === 5) {
      lines.push({
        index,
        kind: "added",
        raw: "+const value = validate(request.value) 中文 long content that wraps in a narrow terminal",
        newLine: 14,
      });
    } else if (index === 9) {
      lines.push({
        index,
        kind: "no-newline-marker",
        raw: "\\ No newline at end of file",
      });
    } else {
      lines.push({
        index,
        kind: "context",
        raw: ` context line ${index}\u001b[31m`,
        oldLine: 10 + index,
        newLine: 10 + index,
      });
    }
  }
  return lines;
}

function replaceHunkLines(
  snapshot: ReviewSnapshot,
  linesByHunkId: ReadonlyMap<HunkId, readonly DiffLine[]>,
): ReviewSnapshot {
  return {
    ...snapshot,
    changes: snapshot.changes.map((change) =>
      change.content.kind === "text"
        ? {
            ...change,
            content: {
              kind: "text",
              hunks: change.content.hunks.map((hunk) => ({
                ...hunk,
                lines: linesByHunkId.get(hunk.id) ?? hunk.lines,
              })),
            },
          }
        : change,
    ),
  };
}

function createHarness(
  columns = 80,
  rows = 24,
  fixture: UiFixture = makeUiFixture(),
): ComponentHarness {
  const terminal = new FakeTerminal(columns, rows);
  const tui = new TUI(terminal, false);
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const submittedModes: ReviewSubmissionMode[] = [];
  const cancellations = { count: 0 };
  const component = new GuidedReviewComponent({
    tui,
    theme: plainTheme,
    keybindings: createKeybindings(),
    snapshot: fixture.snapshot,
    delta: fixture.delta,
    route: fixture.route,
    session,
    onSubmit: (mode) => submittedModes.push(mode),
    onCancel: () => {
      cancellations.count += 1;
    },
  });
  tui.addChild(component);
  tui.setFocus(component);
  return { component, session, terminal, submittedModes, cancellations };
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

test("renders agent commentary separately from frozen Git diff without terminal injection", () => {
  const harness = createHarness(100, 30);

  const lines = harness.component.render(harness.terminal.columns);
  const output = lines.join("\n");

  assert.ok(
    lines.every((line) => !line.includes("\n") && !line.includes("\r")),
  );
  assert.match(output, /Agent explanation/);
  assert.match(output, /Git snapshot diff/);
  assert.match(output, /Request entry point/);
  assert.match(output, /src\/entry 文\\nfile\.ts/);
  assert.match(output, /\\x1b\[2J/);
  assert.match(output, /context line 0\\x1b\[31m/);
  assert.equal(output.includes(`${String.fromCharCode(27)}[2J`), false);
});

test("never renders beyond terminal width or height", () => {
  const harness = createHarness();

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
    assert.ok(lines.length <= rows, `${columns}x${rows} exceeded row count`);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= columns,
        `${JSON.stringify(line)} exceeded width ${columns}`,
      );
    }
  }
});

test("keeps the selected diff line visible while navigating a tall unit", () => {
  const harness = createHarness(54, 12);

  press(harness.component, "j", "j", "j", "j", "j");
  const output = renderText(harness);

  assert.match(output, />\s+\d*\s+14\s+\+const value = validate/);
  assert.match(output, /Git snapshot diff/);
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
  assert.match(renderText(harness), /context line 2/);
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

  const comment = harness.session.getComments()[0];
  assert.equal(comment?.body, "请检查\n失败路径");
  assert.equal(comment?.diffLineIndex, 0);
  assert.match(renderText(harness), /comments 1/);
});

test("prefills an existing comment and discards an edit without changing it", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "O", "r", "i", "g", "i", "n", "a", "l", "\r");

  press(harness.component, "c");
  assert.match(renderText(harness), /Original/);
  press(harness.component, "!", "\u001b");

  assert.equal(harness.session.getComments()[0]?.body, "Original");
  assert.match(renderText(harness), /Git snapshot diff/);
});

test("keeps the comment editor open for a blank body error", () => {
  const harness = createHarness(80, 24);

  press(harness.component, "c", "\r");

  assert.match(renderText(harness), /Review comment body must not be blank/);
  assert.deepEqual(harness.session.getComments(), []);
  assert.ok(renderText(harness).includes(CURSOR_MARKER));
});

test("deletes the selected comment idempotently from the walkthrough", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "e", "l", "e", "t", "e", "\r");
  assert.equal(harness.session.getComments().length, 1);

  press(harness.component, "d");
  assert.deepEqual(harness.session.getComments(), []);
  assert.match(renderText(harness), /comments 0/);

  press(harness.component, "d");
  assert.deepEqual(harness.session.getComments(), []);
});

test("shows complete explanation and returns to the selected diff", () => {
  const harness = createHarness(60, 14);

  press(harness.component, "e");
  assert.match(renderText(harness), /Agent explanation/);
  assert.match(renderText(harness), /Review focus/);
  press(harness.component, "\u001b");

  assert.match(renderText(harness), /Git snapshot diff/);
});

test("shows planned, carried, skipped, unsupported, and notice inventory", () => {
  const harness = createHarness(100, 40);

  press(harness.component, "i");
  const output = renderText(harness);
  assert.match(output, /planned:/);
  assert.match(output, /carried-forward:/);
  assert.match(output, /skipped:/);
  assert.match(output, /Generated output is represented/);
  assert.match(output, /unsupported:.*asset\.bin/);
  assert.match(output, /Binary content cannot be reviewed/);
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

test("shows the complete batch and selected submission mode", () => {
  const harness = createHarness(100, 40);
  press(harness.component, "c", "C", "h", "e", "c", "k", "\r", "s");

  let output = renderText(harness);
  assert.match(output, /Comment batch and submission mode/);
  assert.match(output, /> Discuss first/);
  assert.match(output, /Check/);
  assert.match(output, /Explicitly skipped hunks/);
  assert.match(output, /Unsupported changes and notices/);

  press(harness.component, "\u001b[C");
  output = renderText(harness);
  assert.match(output, /> Apply change requests/);
  press(harness.component, "\r");
  assert.deepEqual(harness.submittedModes, ["apply-change-requests"]);
});

test("blocks input during drift verification and preserves drafts on failure", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "s");

  harness.component.setSubmissionChecking();
  press(harness.component, "\u001b", "\u001b[C", "\r");
  assert.deepEqual(harness.submittedModes, []);

  harness.component.setSubmissionBlocked("repository changed");
  assert.match(renderText(harness), /Submission blocked: repository changed/);
  assert.equal(harness.session.getComments()[0]?.body, "Draft");
});

test("requires explicit confirmation before cancelling without exposing drafts", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "\u001b");

  assert.match(renderText(harness), /Cancel guided review/);
  assert.match(renderText(harness), /will not be\s+returned to the agent/);
  press(harness.component, "\u001b");
  assert.equal(harness.cancellations.count, 0);
  assert.match(renderText(harness), /Git snapshot diff/);

  press(harness.component, "\u001b", "\r");
  assert.equal(harness.cancellations.count, 1);
});

test("supports an empty walkthrough when no hunk requires review", () => {
  const snapshot = makeSnapshot("snapshot-empty-ui", []);
  const delta: ReviewDelta = {
    currentSnapshotId: snapshot.id,
    hunks: [],
    removedHunkFingerprints: [],
  };
  const route = validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units: [],
    skippedHunks: [],
  });
  const harness = createHarness(80, 12, { snapshot, delta, route });

  assert.match(renderText(harness), /No review units were planned/);
  press(harness.component, "s", "\r");
  assert.deepEqual(harness.submittedModes, ["discuss-first"]);
});

test("opens custom UI and verifies the frozen snapshot before submission", async () => {
  const fixture = makeUiFixture();
  const terminal = new FakeTerminal(80, 24);
  const tui = new TUI(terminal, false);
  let verifiedSnapshotId: string | undefined;
  const custom: ExtensionContext["ui"]["custom"] = async <Result>(
    factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
  ): Promise<Result> =>
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
        component.handleInput?.("s");
        component.handleInput?.("\r");
      }, reject);
    });
  const ui = { custom } as unknown as ExtensionContext["ui"];

  const result = await openGuidedReview(
    { mode: "tui", ui },
    {
      ...fixture,
      verifySnapshot: async (snapshot) => {
        verifiedSnapshotId = snapshot.id;
      },
    },
  );

  assert.equal(verifiedSnapshotId, fixture.snapshot.id);
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") {
    assert.equal(result.submissionMode, "discuss-first");
  }
});

test("fails clearly before opening custom UI outside TUI mode", async () => {
  const fixture = makeUiFixture();
  const ui = {} as ExtensionContext["ui"];

  await assert.rejects(
    openGuidedReview(
      { mode: "print", ui },
      {
        ...fixture,
        verifySnapshot: async () => {},
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
