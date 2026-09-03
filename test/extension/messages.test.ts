import assert from "node:assert/strict";
import test from "node:test";
import { formatGuidedReviewResult } from "../../src/extension/model-payloads.ts";
import { REVIEW_RESPONSES_TOOL_NAME } from "../../src/extension/prompts.ts";
import {
  buildKickoffMessageDetails,
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
  type KickoffMessageDetails,
  renderKickoffMessage,
  renderSubmittedReviewMessage,
  type SubmittedReviewMessageDetails,
} from "../../src/extension/tui-messages.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import type {
  GuidedReviewResult,
  ReviewThreadBatch,
  SnapshotId,
} from "../../src/review/types.ts";
import { makeSnapshot } from "../support/domain-fixtures.ts";
import {
  binaryChange,
  commandContext,
  commentFixture,
  createHarness,
  modeChange,
  plainTheme,
  renderedText,
  renderedToolResult,
  toolContext,
  toolRenderContext,
  toolResultWithoutDetails,
  validRoute,
} from "./harness.ts";

test("renders every successful guided-review outcome", async () => {
  const pausedHarness = createHarness();
  await pausedHarness.command("", commandContext());
  const paused = await pausedHarness.tool.execute(
    "call-paused",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  assert.ok(pausedHarness.tool.renderCall);
  assert.equal(
    renderedText(
      pausedHarness.tool.renderCall(
        validRoute(),
        plainTheme,
        toolRenderContext(),
      ),
      120,
    ),
    "DiffWalk review",
  );
  assert.equal(
    renderedToolResult(pausedHarness.tool, paused),
    [
      "Review paused",
      "Progress and draft comments remain resumable while the snapshot matches.",
      "Repository changes are allowed; the next /diffwalk discards a stale review and starts over.",
    ].join("\n"),
  );

  const discardedHarness = createHarness({ discardOnOpen: true });
  await discardedHarness.command("", commandContext());
  const discarded = await discardedHarness.tool.execute(
    "call-discarded",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(
    renderedToolResult(discardedHarness.tool, discarded),
    ["Review discarded", "Progress and draft comments removed."].join("\n"),
  );

  const noCommentsHarness = createHarness({ submitOnOpen: true });
  await noCommentsHarness.command("", commandContext());
  const noComments = await noCommentsHarness.tool.execute(
    "call-no-comments",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const noCommentsText = renderedToolResult(noCommentsHarness.tool, noComments);
  assert.equal(
    noCommentsText,
    [
      "Review complete",
      "No comments submitted.",
      "No agent follow-up needed.",
    ].join("\n"),
  );

  const commentsHarness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await commentsHarness.command("", commandContext());
  const comments = await commentsHarness.tool.execute(
    "call-comments",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const commentsText = renderedToolResult(commentsHarness.tool, comments);
  assert.equal(
    commentsText,
    [
      "Review complete",
      "1 comment sent to the agent.",
      "Next step: Discuss comments before making changes",
    ].join("\n"),
  );
});

test("does not expose protocol JSON when successful result details are missing", () => {
  const harness = createHarness();
  const protocolJson = formatGuidedReviewResult({
    status: "submitted",
    snapshotId: "snapshot-index" as SnapshotId,
    submissionMode: "discuss-first",
    comments: [],
  });

  assert.equal(
    renderedToolResult(harness.tool, toolResultWithoutDetails(protocolJson)),
    "Review finished.",
  );
});

test("registers compact TUI renderers for the kickoff and result messages", () => {
  const harness = createHarness();
  assert.deepEqual(harness.registeredRenderers, [
    DIFFWALK_KICKOFF_MESSAGE_TYPE,
    DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
  ]);
});

test("builds user-facing kickoff details with concrete additional changes", () => {
  const snapshot = makeSnapshot(
    "snapshot-details",
    [{ path: "src/file.ts", lines: [" head", "+changed", " tail"] }],
    { changes: [binaryChange(), modeChange()] },
  );

  assert.deepEqual(
    buildKickoffMessageDetails(snapshot, computeReviewDelta(snapshot)),
    {
      targetRef: "main",
      changedFileCount: 3,
      needsReviewLineCount: 1,
      carriedForwardLineCount: 0,
      additionalChanges: [
        { path: "assets/logo.png", description: "binary file" },
        {
          path: "scripts/deploy.sh",
          description: "file permissions changed",
        },
      ],
    },
  );
});

test("renders kickoff facts on separate lines without protocol details", () => {
  const kickoffPrompt = "Prepare a semantic route for snapshot snapshot-index.";
  const message = {
    role: "custom" as const,
    customType: DIFFWALK_KICKOFF_MESSAGE_TYPE,
    content: kickoffPrompt,
    display: true,
    details: {
      targetRef: "origin/main",
      changedFileCount: 3,
      needsReviewLineCount: 5,
      carriedForwardLineCount: 1,
      additionalChanges: [
        { path: "assets/logo.png", description: "binary file" },
        {
          path: "scripts/deploy.sh",
          description: "file permissions changed",
        },
      ],
    } satisfies KickoffMessageDetails,
    timestamp: Date.now(),
  };

  const collapsed = renderKickoffMessage(
    message,
    { expanded: false, outputPad: 0 },
    plainTheme,
  );
  assert.ok(collapsed);
  const collapsedText = renderedText(collapsed, 200);
  assert.equal(
    collapsedText,
    [
      "DiffWalk",
      "Compared with: origin/main",
      "Changed files: 3",
      "Lines to review: 5",
      "Previously reviewed: 1 line",
      "Additional changes:",
      "  assets/logo.png: binary file",
      "  scripts/deploy.sh: file permissions changed",
    ].join("\n"),
  );
  assert.doesNotMatch(collapsedText, /snapshot|agent|route-preparation/i);

  const expanded = renderKickoffMessage(
    message,
    { expanded: true, outputPad: 0 },
    plainTheme,
  );
  assert.ok(expanded);
  assert.equal(renderedText(expanded, 200), collapsedText);
});

test("renders submitted agent handoff facts without protocol details", () => {
  const submitted: GuidedReviewResult = {
    status: "submitted",
    snapshotId: "snapshot-index" as SnapshotId,
    submissionMode: "discuss-first",
    comments: [],
  };
  const message = {
    role: "custom" as const,
    customType: DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    content: formatGuidedReviewResult(submitted),
    display: true,
    details: {
      submissionMode: "discuss-first",
      commentCount: 2,
    } satisfies SubmittedReviewMessageDetails,
    timestamp: Date.now(),
  };

  const collapsed = renderSubmittedReviewMessage(
    message,
    { expanded: false, outputPad: 0 },
    plainTheme,
  );
  assert.ok(collapsed);
  const collapsedText = renderedText(collapsed, 120);
  assert.equal(
    collapsedText,
    [
      "DiffWalk review complete",
      "2 comments sent to the agent.",
      "Next step: Discuss comments before making changes",
    ].join("\n"),
  );
  const expanded = renderSubmittedReviewMessage(
    message,
    { expanded: true, outputPad: 0 },
    plainTheme,
  );
  assert.ok(expanded);
  assert.equal(renderedText(expanded, 400), collapsedText);

  const applyDirectly = renderSubmittedReviewMessage(
    {
      ...message,
      details: {
        submissionMode: "apply-change-requests",
        commentCount: 2,
      },
    },
    { expanded: false, outputPad: 0 },
    plainTheme,
  );
  assert.ok(applyDirectly);
  assert.match(
    renderedText(applyDirectly, 120),
    /Next step: Apply requested changes/,
  );
});

test("formats structured pause, discard, and submission instructions", () => {
  const paused: GuidedReviewResult = {
    status: "paused",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  const formattedPause = JSON.parse(formatGuidedReviewResult(paused)) as {
    readonly status: string;
    readonly instruction: string;
  };
  assert.equal(formattedPause.status, "paused");
  assert.match(
    formattedPause.instruction,
    /Follow the user's next request normally, including requests to modify repository files or Git state/,
  );
  assert.match(
    formattedPause.instruction,
    /next \/diffwalk discards a stale review and starts from a fresh snapshot/,
  );
  assert.doesNotMatch(formattedPause.instruction, /Do not modify/);

  const discarded: GuidedReviewResult = {
    status: "discarded",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  const formattedDiscard = JSON.parse(formatGuidedReviewResult(discarded)) as {
    readonly instruction: string;
  };
  assert.match(formattedDiscard.instruction, /discarded the review/);

  const submitted: GuidedReviewResult = {
    status: "submitted",
    snapshotId: "snapshot-index" as SnapshotId,
    submissionMode: "discuss-first",
    comments: [commentFixture()],
    commentBatchId: "batch-index" as ReviewThreadBatch["id"],
  };
  const formatted = JSON.parse(formatGuidedReviewResult(submitted)) as {
    readonly commentBatchId: string;
    readonly turnId: string;
    readonly comments: readonly { readonly threadId: string }[];
    readonly instruction: string;
  };
  assert.equal(formatted.commentBatchId, "batch-index");
  assert.equal(formatted.turnId, "T1");
  assert.equal(formatted.comments[0]?.threadId, "C1");
  assert.match(formatted.instruction, /without modifying files/);
  assert.match(formatted.instruction, new RegExp(REVIEW_RESPONSES_TOOL_NAME));
  assert.match(
    formatted.instruction,
    /Do not answer in ordinary assistant text/,
  );
});
