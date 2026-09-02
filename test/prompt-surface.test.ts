import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  formatGuidedReviewResult,
  formatReviewThreadFollowUp,
} from "../src/index.ts";
import {
  buildReviewKickoffPrompt,
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
  GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
} from "../src/prompts.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { detectExactMoves } from "../src/review-moves.ts";
import {
  appendReviewThreadTurn,
  attachReviewThreadResponses,
  createReviewThreadBatch,
  REVIEW_RESPONSES_TOOL_DESCRIPTION,
  REVIEW_RESPONSES_TOOL_NAME,
  REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET,
  ReviewResponseCandidateSchema,
} from "../src/review-threads.ts";
import {
  assessRouteQuality,
  formatAdvisoryNudge,
} from "../src/route-advisory.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  FileChange,
  NoticeId,
  ReviewComment,
  ReviewRoundId,
  ReviewRouteCandidate,
  ReviewSeriesId,
  ReviewThreadBatchId,
  SnapshotId,
} from "../src/types.ts";
import { ReviewRouteCandidateSchema } from "../src/types.ts";
import { makeRound, makeSnapshot, span } from "./domain-fixtures.ts";

/**
 * The complete standing model-visible surface, rendered over fixed fixtures
 * through the real builders and pinned to a golden file. Rewording or
 * recomposing anything the model can see fails this test, so changing the
 * prompt surface is always an explicit, reviewable act.
 *
 * Deliberately outside the surface: validation error text. Those messages are
 * conflict feedback for a specific broken route, the designated channel for
 * explaining a rejection, and pinning them would add ceremony to every
 * validator improvement without protecting any standing instruction.
 *
 * Regenerate the golden file with:
 *
 *   DIFFWALK_UPDATE_GOLDEN=1 node --test test/prompt-surface.test.ts
 */

const GOLDEN_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "prompt-surface.golden.txt",
);

const MOVED_BLOCK = [
  "const total = computeTotalAmount(items);",
  "const tax = totalAmount * currentTaxRate;",
  "return { totalAmount, taxAmount: tax };",
] as const;

const BINARY_CHANGE: FileChange = {
  id: "file:modified:assets/logo.png" as FileChange["id"],
  source: "tracked",
  status: "modified",
  oldPath: "assets/logo.png",
  newPath: "assets/logo.png",
  oldMode: "100644",
  newMode: "100644",
  gitHeaderLines: [],
  content: {
    type: "binary",
    gitBodyLines: [],
    unsupportedReason: "Binary changes are not reviewable as text.",
  },
};

/** Fresh review: new lines, a move pair, a binary file, and a notice. */
function kickoffWithMoves(): string {
  const snapshot = makeSnapshot(
    "snapshot-surface-moves",
    [
      {
        path: "src/from.ts",
        lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
      },
      {
        path: "src/to.ts",
        lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
      },
    ],
    {
      changes: [BINARY_CHANGE],
      notices: [
        {
          id: "notice:surface" as NoticeId,
          type: "cancelled-layer-change",
          filePath: "src/cancelled.ts",
          message: "Staged and unstaged changes cancel in the worktree.",
        },
      ],
    },
  );
  return buildReviewKickoffPrompt(snapshot, computeReviewDelta(snapshot));
}

/** Incremental review: carried-forward, unresolved-comment, and previously-skipped lines, no moves. */
function kickoffWithoutMoves(): string {
  const snapshot = makeSnapshot("snapshot-surface-delta", [
    {
      path: "src/entry.ts",
      lines: [" head", "+reviewed", "+commented", "+skipped", " tail"],
    },
  ]);
  const baseline = makeRound({
    id: "round-surface",
    snapshot,
    dispositions: {
      "src/entry.ts:new:3": "commented",
      "src/entry.ts:new:4": "skipped",
    },
  });
  return buildReviewKickoffPrompt(
    snapshot,
    computeReviewDelta(snapshot, baseline),
    {
      scope: "project",
      content: "- Keep behavioral tests with the code they prove.",
    },
  );
}

/** A mechanical route over a move fixture, firing all three advisory signals. */
function advisoryNudge(): string {
  const snapshot = makeSnapshot("snapshot-surface-advisory", [
    {
      path: "src/a.ts",
      lines: [" head", ...MOVED_BLOCK.map((line) => `-${line}`), " tail"],
    },
    { path: "src/b.ts", lines: [" head", "+beta", " tail"] },
    {
      path: "src/c.ts",
      lines: [" top", ...MOVED_BLOCK.map((line) => `+${line}`), " bottom"],
    },
  ]);
  const mechanicalUnit = (
    title: string,
    unitSpan: ReviewRouteCandidate["units"][number]["spans"][number],
  ): ReviewRouteCandidate["units"][number] => ({
    title,
    whyHere: "Fixture ordering.",
    context: "Fixture context.",
    changeSummary: "Fixture change.",
    reviewFocus: [{ question: "Fixture question?" }],
    spans: [unitSpan],
  });
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      mechanicalUnit("A", span("src/a.ts", { old: [2, 4] })),
      mechanicalUnit("B", span("src/b.ts", { new: [2, 2] })),
      mechanicalUnit("C", span("src/c.ts", { new: [2, 4] })),
    ],
    skippedSpans: [],
  });
  const issues = assessRouteQuality(
    snapshot,
    route,
    detectExactMoves(snapshot),
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["hunk-mirroring", "alphabetical-order", "split-move"],
    "The advisory fixture must fire every signal branch.",
  );
  return formatAdvisoryNudge(issues);
}

function toolSurface(): string {
  return [
    `name: ${GUIDED_REVIEW_TOOL_NAME}`,
    `description: ${GUIDED_REVIEW_TOOL_DESCRIPTION}`,
    `promptSnippet: ${GUIDED_REVIEW_TOOL_PROMPT_SNIPPET}`,
    `parameters: ${JSON.stringify(ReviewRouteCandidateSchema)}`,
  ].join("\n");
}

function responseToolSurface(): string {
  return [
    `name: ${REVIEW_RESPONSES_TOOL_NAME}`,
    `description: ${REVIEW_RESPONSES_TOOL_DESCRIPTION}`,
    `promptSnippet: ${REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET}`,
    `parameters: ${JSON.stringify(ReviewResponseCandidateSchema)}`,
  ].join("\n");
}

function surfaceComment(snapshotId: SnapshotId): ReviewComment {
  return {
    snapshotId,
    reviewUnitId: "review-unit:surface" as ReviewComment["reviewUnitId"],
    fileChangeId: "file:surface" as ReviewComment["fileChangeId"],
    side: "new",
    line: 7,
    filePath: "src/surface.ts",
    oldPath: "src/surface.ts",
    newPath: "src/surface.ts",
    newLine: 7,
    selectedText: "surface line",
    nearbyContext: [{ type: "added", newLine: 7, text: "surface line" }],
    body: "Explain this behavior.",
  };
}

function resultSurface(): string {
  const snapshotId = "snapshot-surface" as SnapshotId;
  const commentBatchId = "review-thread-batch:surface" as ReviewThreadBatchId;
  return [
    "--- paused ---",
    formatGuidedReviewResult({ status: "paused", snapshotId }),
    "--- discarded ---",
    formatGuidedReviewResult({ status: "discarded", snapshotId }),
    "--- submitted, discuss-first ---",
    formatGuidedReviewResult({
      status: "submitted",
      snapshotId,
      submissionMode: "discuss-first",
      comments: [surfaceComment(snapshotId)],
      commentBatchId,
    }),
    "--- submitted, apply-change-requests ---",
    formatGuidedReviewResult({
      status: "submitted",
      snapshotId,
      submissionMode: "apply-change-requests",
      comments: [surfaceComment(snapshotId)],
      commentBatchId,
    }),
  ].join("\n");
}

function followUpSurface(): string {
  const snapshotId = "snapshot-surface" as SnapshotId;
  const pending = createReviewThreadBatch({
    seriesId: "series-surface" as ReviewSeriesId,
    roundId: "round-surface" as ReviewRoundId,
    snapshotId,
    submissionMode: "discuss-first",
    comments: [surfaceComment(snapshotId)],
  });
  const answered = attachReviewThreadResponses(pending, {
    batchId: pending.id,
    turnId: "T1",
    responses: [{ threadId: "C1", body: "The guard prevents stale writes." }],
  });
  const thread = answered.threads[0];
  assert.ok(thread);
  const followUp = appendReviewThreadTurn(answered, {
    submissionMode: "apply-change-requests",
    replies: [
      {
        threadId: thread.id,
        body: "Please add a regression test for that guard.",
      },
    ],
  });
  const turn = followUp.turns.at(-1);
  assert.ok(turn);
  return formatReviewThreadFollowUp(followUp, turn.id);
}

function renderSurface(): string {
  const sections: readonly [string, string][] = [
    ["kickoff prompt: fresh review with moves", kickoffWithMoves()],
    [
      "kickoff prompt: incremental review with selected project rules without moves",
      kickoffWithoutMoves(),
    ],
    ["guided_review tool", toolSurface()],
    ["submit_diffwalk_responses tool", responseToolSurface()],
    ["tool results", resultSurface()],
    ["reviewer follow-up tool result", followUpSurface()],
    ["advisory nudge", advisoryNudge()],
  ];
  return sections
    .map(([title, body]) => `=== ${title} ===\n${body}\n`)
    .join("\n");
}

test("pins the complete standing model-visible surface to the golden file", () => {
  const surface = renderSurface();

  // The surface states coordinates, never file content. The fixture source
  // text leaking into any prompt would change this golden file immediately.
  assert.equal(surface.includes("computeTotalAmount"), false);
  assert.equal(surface.includes(MOVED_BLOCK[1]), false);

  if (process.env.DIFFWALK_UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, surface);
  }
  const golden = readFileSync(GOLDEN_PATH, "utf8");
  assert.equal(
    surface,
    golden,
    "The model-visible prompt surface changed. Review the diff, then regenerate with DIFFWALK_UPDATE_GOLDEN=1 node --test test/prompt-surface.test.ts",
  );
});
