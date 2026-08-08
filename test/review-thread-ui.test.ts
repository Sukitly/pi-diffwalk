import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ReviewSession } from "../src/review-comments.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import {
  ReviewThreadComponent,
  ReviewThreadUiError,
  type ReviewThreadUiResult,
} from "../src/review-thread-ui.ts";
import {
  appendReviewThreadTurn,
  attachReviewThreadResponses,
  createReviewThreadBatch,
  setReviewThreadResolved,
} from "../src/review-threads.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  ReviewCommentId,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewThreadBatch,
  ReviewThreadTurnId,
} from "../src/types.ts";
import { fileChangeId, makeSnapshot, span } from "./domain-fixtures.ts";

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

const cardTheme = {
  ...plainTheme,
  bg: (color: Parameters<Theme["bg"]>[0], text: string) => {
    const code = color === "userMessageBg" ? 24 : 25;
    return `\u001b[48;5;${code}m${text}\u001b[49m`;
  },
} satisfies Pick<Theme, "fg" | "bg" | "bold">;

interface ForegroundCall {
  readonly color: ThemeColor;
  readonly text: string;
}

function recordingTheme(calls: ForegroundCall[]) {
  return {
    ...plainTheme,
    fg: (color: ThemeColor, text: string) => {
      calls.push({ color, text });
      return text;
    },
  } satisfies Pick<Theme, "fg" | "bg" | "bold">;
}

function fixture(): {
  readonly snapshot: ReturnType<typeof makeSnapshot>;
  readonly pending: ReviewThreadBatch;
  readonly answered: ReviewThreadBatch;
} {
  const snapshot = makeSnapshot("snapshot-thread-ui", [
    {
      path: "src/thread.ts",
      lines: [
        " outside start",
        " context 2",
        " context 3",
        " context 4",
        "+first changed",
        " between 6",
        " between 7",
        " between 8",
        " unrelated 9",
        " unrelated 10",
        " unrelated 11",
        " unrelated 12",
        " context 13",
        " context 14",
        " context 15",
        "+second changed",
        " context 17",
        " context 18",
        " context 19",
        " outside end",
      ],
    },
  ]);
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Thread UI",
        whyHere: "The comments belong together.",
        context: "first -> second",
        changeSummary: "Adds two lines.",
        reviewFocus: ["Are both additions correct?"],
        spans: [span("src/thread.ts", { new: [1, 20] })],
      },
    ],
    skippedSpans: [],
  });
  const unit = route.units[0];
  assert.ok(unit);
  const session = new ReviewSession(snapshot, route);
  for (const [line, body] of [
    [5, "Why is the first line needed?"],
    [16, "What guarantees the second line?"],
  ] as const) {
    session.upsertComment({
      reviewUnitId: unit.id,
      fileChangeId: fileChangeId("modified", "src/thread.ts"),
      side: "new",
      line,
      body,
    });
  }
  const pending = createReviewThreadBatch({
    seriesId: "series-ui" as ReviewSeriesId,
    roundId: "round-ui" as ReviewRoundId,
    snapshotId: snapshot.id,
    submissionMode: "discuss-first",
    comments: session.getComments(),
  });
  const answered = attachReviewThreadResponses(pending, {
    batchId: pending.id,
    turnId: "T1",
    responses: [
      { threadId: "C1", body: "The first line validates the input." },
      { threadId: "C2", body: "The contract test guarantees the second." },
    ],
  });
  return { snapshot, pending, answered };
}

function createComponent(
  batch: ReviewThreadBatch,
  rows = 24,
  theme: Pick<Theme, "fg" | "bg" | "bold"> = plainTheme,
) {
  const { snapshot } = fixture();
  const terminal = new FakeTerminal(100, rows);
  const tui = new TuiMainScreen(terminal, false);
  const changes: ReviewThreadBatch[] = [];
  const outcomes: ReviewThreadUiResult[] = [];
  const component = new ReviewThreadComponent({
    snapshot,
    batch,
    tui,
    theme,
    onBatchChange: (next) => changes.push(next),
    onClose: (result) => outcomes.push(result),
  });
  tui.addChild(component);
  tui.setFocus(component);
  return { component, terminal, changes, outcomes };
}

function press(component: ReviewThreadComponent, ...keys: string[]): void {
  for (const key of keys) component.handleInput(key);
}

function attachAnsweredFollowUp(
  batch: ReviewThreadBatch,
  items: readonly {
    readonly threadId: ReviewCommentId;
    readonly reviewerBody: string;
    readonly agentBody: string;
  }[],
): ReviewThreadBatch {
  const pending = appendReviewThreadTurn(batch, {
    submissionMode: "discuss-first",
    replies: items.map((item) => ({
      threadId: item.threadId,
      body: item.reviewerBody,
    })),
  });
  const turn = pending.turns.at(-1);
  assert.ok(turn);
  return attachReviewThreadResponses(pending, {
    batchId: pending.id,
    turnId: turn.id,
    responses: items.map((item) => ({
      threadId: item.threadId,
      body: item.agentBody,
    })),
  });
}

test("renders Agent responses at frozen anchors and omits unrelated lines", () => {
  const { answered } = fixture();
  const { component } = createComponent(answered, 40);
  const output = component.render(100).join("\n");

  assert.match(output, /\+first changed[\s\S]*C1 · ○ Open · Turn 1/);
  assert.match(
    output,
    /You[\s\S]*Why is the first line needed\?[\s\S]*Agent[\s\S]*first line validates/,
  );
  assert.match(output, /\+second changed[\s\S]*C2 · ○ Open · Turn 1/);
  assert.match(output, /contract test guarantees the second/);
  assert.doesNotMatch(output, /outside start|outside end|unrelated 10/);
});

test("shows complete responsive thread header information when height permits", () => {
  const { answered } = fixture();
  const { component } = createComponent(answered, 40);

  let lines = component.render(100).map((line) => line.trimEnd());
  assert.match(lines[0] ?? "", /^DiffWalk \/ Threads.*Thread 1\/2$/);
  assert.match(lines[1] ?? "", /^C1 · ○ Open.*2\/2 answered.*0\/2 resolved/);

  lines = component.render(60).map((line) => line.trimEnd());
  assert.equal(lines[0], "DiffWalk / Threads · Thread 1/2");
  assert.equal(lines[1], "C1 · ○ Open");
  assert.match(lines[2] ?? "", /2\/2 answered.*0\/2 resolved.*0 drafts/);

  lines = component.render(30).map((line) => line.trimEnd());
  assert.equal(lines[0], "DiffWalk / Threads");
  assert.equal(lines[1], "Thread 1/2");
  assert.equal(lines[2], "C1 · ○ Open");
  assert.match(lines.slice(3, 6).join("\n"), /2\/2 answered/);
  assert.match(lines.slice(3, 6).join("\n"), /0\/2 resolved/);
  assert.match(lines.slice(3, 6).join("\n"), /0 drafts/);
});

test("uses neutral and success roles for thread status surfaces", () => {
  const { answered } = fixture();
  const calls: ForegroundCall[] = [];
  const { component } = createComponent(answered, 30, recordingTheme(calls));

  component.render(100);
  assert.deepEqual(
    calls.filter((call) => call.text === "○ Open"),
    Array.from({ length: 3 }, () => ({
      color: "accent",
      text: "○ Open",
    })),
  );

  calls.length = 0;
  press(component, "r");
  component.render(100);
  assert.deepEqual(
    calls.filter((call) => call.text === "✓ Resolved"),
    Array.from({ length: 2 }, () => ({
      color: "success",
      text: "✓ Resolved",
    })),
  );
});

test("renders multiple turns in order under the same inline thread", () => {
  const { answered } = fixture();
  const multiTurn = attachAnsweredFollowUp(answered, [
    {
      threadId: "C1" as ReviewCommentId,
      reviewerBody: "Why is that validation sufficient?",
      agentBody: "The parser rejects every other shape.",
    },
  ]);
  const { component } = createComponent(multiTurn, 40);
  const output = component.render(100).join("\n");

  assert.match(
    output,
    /C1 · ○ Open · Turn 1[\s\S]*You[\s\S]*Agent[\s\S]*C1 · Turn 2[\s\S]*validation sufficient[\s\S]*Agent[\s\S]*parser rejects/,
  );
});

test("uses one delimiter role across header and thread turns", () => {
  const { answered } = fixture();
  const multiTurn = attachAnsweredFollowUp(answered, [
    {
      threadId: "C1" as ReviewCommentId,
      reviewerBody: "Why is that validation sufficient?",
      agentBody: "The parser rejects every other shape.",
    },
  ]);
  const calls: ForegroundCall[] = [];
  const { component } = createComponent(multiTurn, 40, recordingTheme(calls));

  component.render(100);

  assert.deepEqual(
    calls.filter((call) => call.text === " · "),
    Array.from({ length: 4 }, () => ({ color: "dim", text: " · " })),
  );
});

test("renders turn sequence without parsing the opaque turn id", () => {
  const { answered } = fixture();
  const opaque: ReviewThreadBatch = {
    ...answered,
    turns: answered.turns.map((turn) => ({
      ...turn,
      id: "opaque-turn-id" as ReviewThreadTurnId,
      sequence: 7,
    })),
  };
  const { component } = createComponent(opaque, 40);
  const output = component.render(100).join("\n");

  assert.match(output, /Turn 7/);
  assert.doesNotMatch(output, /opaque-turn-id/);
});

test("renders thread status only on the first turn header", () => {
  const { answered } = fixture();
  const multiTurn = attachAnsweredFollowUp(answered, [
    {
      threadId: "C1" as ReviewCommentId,
      reviewerBody: "Why is that validation sufficient?",
      agentBody: "The parser rejects every other shape.",
    },
  ]);
  const { component } = createComponent(multiTurn, 40);
  const output = component.render(100).join("\n");

  assert.equal(output.match(/C1 · ○ Open · Turn \d+/g)?.length, 1);
  assert.match(output, /C1 · ○ Open · Turn 1/);
  assert.match(output, /C1 · Turn 2/);
});

test("keeps thread ownership visible when paging through later turns", () => {
  const { answered } = fixture();
  const multiTurn = attachAnsweredFollowUp(answered, [
    {
      threadId: "C1" as ReviewCommentId,
      reviewerBody: "First follow-up.",
      agentBody: "First follow-up response.",
    },
    {
      threadId: "C2" as ReviewCommentId,
      reviewerBody: "Second follow-up.",
      agentBody: "Second follow-up response.",
    },
  ]);
  const { component } = createComponent(multiTurn, 8);

  press(component, "j");
  let output = component.render(100).join("\n");
  for (
    let attempt = 0;
    attempt < 10 && !/C1 · Turn 2/.test(output);
    attempt += 1
  ) {
    press(component, "\u001b[5~");
    output = component.render(100).join("\n");
  }

  assert.match(output, /C2 · ○ Open/);
  assert.doesNotMatch(output, /C1 · ○ Open · Turn 1/);
  assert.match(output, /C1 · Turn 2/);
});

test("renders full-width reviewer and Agent cards with readable wrapping", () => {
  const { answered } = fixture();
  const longAnswer: ReviewThreadBatch = {
    ...answered,
    turns: answered.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              agentResponse: { body: "Long grounded response ".repeat(20) },
            }
          : item,
      ),
    })),
  };
  const width = 160;
  const { component } = createComponent(longAnswer, 50, cardTheme);
  const lines = component.render(width);
  const gutter = " ".repeat(14);
  const reviewerBackground = `${gutter}\u001b[48;5;24m`;
  const agentBackground = `${gutter}\u001b[48;5;25m`;
  const reviewerRows = lines.filter((line) =>
    line.startsWith(reviewerBackground),
  );
  const agentRows = lines.filter((line) => line.startsWith(agentBackground));

  assert.ok(
    reviewerRows.some((line) => line.includes("▌ C1 · ○ Open · Turn 1")),
  );
  assert.ok(agentRows.some((line) => line.includes("  Agent")));
  assert.ok(
    agentRows.some((line) =>
      line.startsWith(`${agentBackground}  Long grounded response`),
    ),
  );
  assert.equal(
    [...reviewerRows, ...agentRows].every(
      (line) => visibleWidth(line) === width && line.endsWith("\u001b[49m"),
    ),
    true,
  );
});

test("uses the embedded Editor for multiline Chinese follow-up drafts", () => {
  const { answered } = fixture();
  const { component, changes } = createComponent(answered, 28);

  press(component, "c");
  assert.match(component.render(100).join("\n"), /Reviewer follow-up/);
  assert.match(
    component.render(100).join("\n"),
    /Frozen snapshot snapshot-thread-ui/,
  );
  assert.ok(component.render(100).join("\n").includes(CURSOR_MARKER));
  press(component, "请", "解", "释", "\n", "失", "败", "路", "径", "\r");

  assert.equal(changes.at(-1)?.threads[0]?.draftReply, "请解释\n失败路径");
  assert.match(
    component.render(100).join("\n"),
    /Draft follow-up[\s\S]*请解释[\s\S]*失败路径/,
  );
});

test("submits saved drafts as a new pending turn with a selectable mode", () => {
  const { answered } = fixture();
  const { component, changes, outcomes } = createComponent(answered, 28);

  press(component, "c", "F", "i", "x", " ", "t", "h", "i", "s", "\r");
  press(component, "\r");
  const submission = component.render(100).join("\n");
  assert.match(submission, /DiffWalk \/ Follow-up/);
  assert.match(submission, /Anchored to frozen snapshot snapshot-thread-ui/);
  assert.match(submission, /New code requires another \/diffwalk review/);
  press(component, "l", "\r");

  const outcome = outcomes[0];
  assert.equal(outcome?.status, "follow-up-submitted");
  if (outcome?.status !== "follow-up-submitted") {
    throw new Error("Expected a submitted follow-up.");
  }
  assert.equal(outcome.turnId, "T2");
  assert.equal(outcome.batch.turns[1]?.submissionMode, "apply-change-requests");
  assert.equal(outcome.batch.turns[1]?.items[0]?.reviewerBody, "Fix this");
  assert.equal(outcome.batch.threads[0]?.draftReply, undefined);
  assert.equal(changes.at(-1)?.turns.length, 2);
});

test("completes with Enter when there are no draft follow-ups", () => {
  const { answered } = fixture();
  const { component, outcomes } = createComponent(answered, 24);

  press(component, "\r");

  assert.equal(outcomes[0]?.status, "closed");
  assert.deepEqual(outcomes[0]?.batch, answered);
});

test("hides previously resolved threads in later follow-up views", () => {
  const { answered } = fixture();
  const resolvedFirst = setReviewThreadResolved(
    answered,
    "C1" as ReviewCommentId,
    true,
  );
  const firstView = createComponent(resolvedFirst, 30);
  const firstOutput = firstView.component.render(100).join("\n");

  assert.doesNotMatch(firstOutput, /C1|Why is the first line needed/);
  assert.match(firstOutput, /C2 · ○ Open · Turn 1/);

  press(firstView.component, "r");
  assert.match(
    firstView.component.render(100).join("\n"),
    /C2 · ✓ Resolved · Turn 1/,
  );
  press(firstView.component, "\r");

  const completed = firstView.outcomes[0];
  assert.equal(completed?.status, "closed");
  if (completed === undefined) throw new Error("Expected a completed view.");

  const calls: ForegroundCall[] = [];
  const laterView = createComponent(completed.batch, 30, recordingTheme(calls));
  const laterOutput = laterView.component.render(100).join("\n");
  assert.match(laterOutput, /All conversations resolved/);
  assert.deepEqual(
    calls.filter((call) => call.text === "All conversations resolved"),
    [{ color: "success", text: "All conversations resolved" }],
  );
  assert.doesNotMatch(laterOutput, /C1|C2|first changed|second changed/);
});

test("lets only the reviewer resolve answered threads without drafts", () => {
  const { answered } = fixture();
  const { component, changes, outcomes } = createComponent(answered, 30);

  press(component, "r");
  assert.equal(changes.at(-1)?.threads[0]?.resolved, true);
  assert.match(component.render(90).join("\n"), /C1 · ✓ Resolved · Turn 1/);

  press(component, "c");
  assert.match(component.render(90).join("\n"), /must be reopened/);
  press(component, "r", "c", "D", "r", "a", "f", "t", "\r", "r");
  assert.match(
    component.render(90).join("\n"),
    /draft reply.*submitted or deleted/,
  );

  press(component, "d", "r", "\r");
  assert.equal(outcomes[0]?.status, "closed");
  assert.equal(outcomes[0]?.batch.threads[0]?.resolved, true);
});

test("keeps unanswered turns open and blocks another reply", () => {
  const { pending } = fixture();
  const { component, changes } = createComponent(pending, 24);

  press(component, "r");
  assert.deepEqual(changes, []);
  assert.match(component.render(80).join("\n"), /cannot be resolved/);
  press(component, "c");
  assert.match(
    component.render(80).join("\n"),
    /still awaiting Agent responses/,
  );
  assert.match(component.render(80).join("\n"), /Awaiting Agent response/);
});

test("short thread screens keep their footer and one content row", () => {
  const { answered } = fixture();
  const { component, terminal } = createComponent(answered, 8);
  terminal.columns = 30;

  for (const rows of [4, 5, 8]) {
    terminal.rows = rows;
    component.invalidate();
    const lines = component.render(30);
    assert.match(lines.at(-1) ?? "", /j\/k thread/);
    assert.match(lines.join("\n"), /C1/);
    assert.doesNotMatch(lines.join("\n"), /answered|resolved|drafts/);
  }

  terminal.rows = 5;
  press(component, "c");
  let lines = component.render(30);
  assert.match(lines.at(-1) ?? "", /Enter save/);
  assert.ok(lines.join("\n").includes(CURSOR_MARKER), lines.join("\n"));

  press(component, "F", "i", "x", "\r", "\r");
  lines = component.render(30);
  assert.match(lines.at(-1) ?? "", /mode|Enter/);
  assert.match(lines.join("\n"), /Anchored to frozen snapshot/);
});

test("bounds every thread UI row on narrow terminals", () => {
  const { answered } = fixture();
  const { component } = createComponent(answered, 8);

  for (const width of [1, 8, 30, 80]) {
    component.invalidate();
    const lines = component.render(width);
    assert.equal(lines.length, 8);
    assert.equal(
      lines.every((line) => visibleWidth(line) === width),
      true,
    );
  }
});

test("rejects a thread batch for another frozen snapshot", () => {
  const { answered } = fixture();
  const other = makeSnapshot("other-snapshot", []);
  const terminal = new FakeTerminal();
  const tui = new TuiMainScreen(terminal, false);

  assert.throws(
    () =>
      new ReviewThreadComponent({
        snapshot: other,
        batch: answered,
        tui,
        theme: plainTheme,
        onBatchChange() {},
        onClose() {},
      }),
    ReviewThreadUiError,
  );
});
