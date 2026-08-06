import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ReviewSession } from "../src/review-comments.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import {
  ReviewThreadComponent,
  ReviewThreadUiError,
} from "../src/review-thread-ui.ts";
import {
  attachReviewThreadResponses,
  createReviewThreadBatch,
} from "../src/review-threads.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  ReviewRoundId,
  ReviewSeriesId,
  ReviewThreadBatch,
} from "../src/types.ts";
import { fileChangeId, makeSnapshot, span } from "./domain-fixtures.ts";

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
    responses: [
      { commentId: "C1", body: "The first line validates the input." },
      { commentId: "C2", body: "The contract test guarantees the second." },
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
  const changes: ReviewThreadBatch[] = [];
  const closed: ReviewThreadBatch[] = [];
  const component = new ReviewThreadComponent({
    snapshot,
    batch,
    theme,
    getRows: () => rows,
    requestRender() {},
    onBatchChange: (next) => changes.push(next),
    onClose: (next) => closed.push(next),
  });
  return { component, changes, closed };
}

test("renders Agent responses at comment anchors and omits unrelated route lines", () => {
  const { answered } = fixture();
  const { component } = createComponent(answered, 40);
  const output = component.render(100).join("\n");

  assert.match(output, /\+first changed[\s\S]*\[C1 • open • You\]/);
  assert.match(
    output,
    /Why is the first line needed\?[\s\S]*\[Agent response\][\s\S]*first line validates/,
  );
  assert.match(output, /\+second changed[\s\S]*\[C2 • open • You\]/);
  assert.match(output, /contract test guarantees the second/);
  assert.doesNotMatch(output, /outside start|outside end|unrelated 10/);
});

test("renders full-width reviewer and Agent cards with readable wrapping", () => {
  const { answered } = fixture();
  const longAnswer = {
    ...answered,
    threads: answered.threads.map((thread, index) =>
      index === 0
        ? {
            ...thread,
            response: { body: "Long grounded response ".repeat(20) },
          }
        : thread,
    ),
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

  assert.ok(reviewerRows.some((line) => line.includes("▌ [C1 • open • You]")));
  assert.ok(
    reviewerRows.some((line) => line.startsWith(`${reviewerBackground}  Why`)),
  );
  assert.ok(agentRows.some((line) => line.includes("[Agent response]")));
  assert.ok(
    agentRows.some((line) =>
      line.startsWith(`${agentBackground}  Long grounded response`),
    ),
  );
  assert.ok(agentRows.length > answered.threads.length * 2);
  assert.equal(
    [...reviewerRows, ...agentRows].every(
      (line) => visibleWidth(line) === width && line.endsWith("\u001b[49m"),
    ),
    true,
  );
});

test("lets only the reviewer resolve and reopen answered threads", () => {
  const { answered } = fixture();
  const { component, changes, closed } = createComponent(answered, 30);

  component.handleInput("r");
  assert.equal(changes.at(-1)?.threads[0]?.resolved, true);
  assert.match(component.render(90).join("\n"), /C1 • resolved/);

  component.handleInput("r");
  assert.equal(changes.at(-1)?.threads[0]?.resolved, false);

  component.handleInput("j");
  component.handleInput("r");
  assert.equal(changes.at(-1)?.threads[1]?.resolved, true);

  component.handleInput("\u001b");
  assert.equal(closed[0]?.threads[1]?.resolved, true);
});

test("keeps unanswered threads open and explains why resolve is blocked", () => {
  const { pending } = fixture();
  const { component, changes } = createComponent(pending, 24);

  component.handleInput("r");

  assert.deepEqual(changes, []);
  assert.match(component.render(80).join("\n"), /has not answered/);
  assert.match(component.render(80).join("\n"), /Awaiting structured response/);
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

  assert.throws(
    () =>
      new ReviewThreadComponent({
        snapshot: other,
        batch: answered,
        theme: plainTheme,
        getRows: () => 24,
        requestRender() {},
        onBatchChange() {},
        onClose() {},
      }),
    ReviewThreadUiError,
  );
});
