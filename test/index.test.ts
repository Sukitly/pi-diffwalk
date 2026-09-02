import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ReviewSnapshotDriftError } from "../src/git-diff.ts";
import {
  markReviewUnitReviewed,
  upsertInProgressReviewComment,
} from "../src/in-progress-review.ts";
import {
  buildKickoffMessageDetails,
  createPiGitRunner,
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
  type DiffWalkDependencies,
  formatGuidedReviewResult,
  type KickoffMessageDetails,
  parseDiffWalkCommand,
  parseReviewTarget,
  registerDiffWalk,
  renderKickoffMessage,
  renderSubmittedReviewMessage,
  type SubmittedReviewMessageDetails,
} from "../src/index.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { DIFFWALK_SERIES_ENTRY_TYPE } from "../src/review-persistence.ts";
import { DIFFWALK_THREAD_BATCH_ENTRY_TYPE } from "../src/review-thread-persistence.ts";
import type { ReviewThreadUiResult } from "../src/review-thread-ui.ts";
import {
  appendReviewThreadTurn,
  REVIEW_RESPONSES_TOOL_NAME,
  type ReviewResponseCandidateSchema,
  setReviewThreadResolved,
} from "../src/review-threads.ts";
import type { DiffWalkRulesLoadResult } from "../src/route-rules.ts";
import type {
  FileChange,
  FileChangeId,
  GuidedReviewResult,
  NoticeId,
  ReviewComment,
  ReviewRouteCandidate,
  ReviewRouteCandidateSchema,
  ReviewSnapshot,
  ReviewThreadBatch,
  SnapshotId,
} from "../src/types.ts";
import { makeSnapshot, span } from "./domain-fixtures.ts";

type GuidedToolDefinition = ToolDefinition<
  typeof ReviewRouteCandidateSchema,
  GuidedReviewResult
>;

type ResponseToolDefinition = ToolDefinition<
  typeof ReviewResponseCandidateSchema,
  ReviewThreadUiResult
>;

interface HarnessBehavior {
  drift: boolean;
  submitOnOpen: boolean;
  discardOnOpen: boolean;
  commentOnSubmit: boolean;
  markProgressOnOpen: boolean;
  submissionDrift: boolean;
  resolveThreadOnOpen: boolean;
  submitFollowUpOnThreadOpen: boolean;
  globalRulesResult: DiffWalkRulesLoadResult;
  projectRulesResult: DiffWalkRulesLoadResult;
  globalRulesError?: Error;
  projectRulesError?: Error;
  snapshot: ReviewSnapshot;
}

interface SentMessageMeta {
  readonly customType: string;
  readonly display: boolean;
  readonly triggerTurn: boolean;
}

interface AppendedEntry {
  readonly customType: string;
  readonly data: unknown;
}

type RuleLoadCall =
  | { readonly scope: "global" }
  | {
      readonly scope: "project";
      readonly repositoryRoot: string;
      readonly projectTrusted: boolean;
    };

interface Harness {
  readonly command: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly tool: GuidedToolDefinition;
  readonly responseTool: ResponseToolDefinition;
  readonly sentMessages: readonly string[];
  readonly sentMessageMeta: readonly SentMessageMeta[];
  readonly registeredRenderers: readonly string[];
  readonly openedSnapshots: readonly string[];
  readonly openedThreadBatches: readonly string[];
  readonly appendedEntries: readonly AppendedEntry[];
  readonly ruleLoadCalls: readonly RuleLoadCall[];
  readonly behavior: HarnessBehavior;
  /** Replays persisted entries into a fresh harness, as session_start does. */
  readonly restoreSession: (entries: readonly AppendedEntry[]) => Promise<void>;
}

function createHarness(
  initialBehavior: Partial<HarnessBehavior> = {},
): Harness {
  const behavior: HarnessBehavior = {
    drift: false,
    submitOnOpen: false,
    discardOnOpen: false,
    commentOnSubmit: false,
    markProgressOnOpen: false,
    submissionDrift: false,
    resolveThreadOnOpen: false,
    submitFollowUpOnThreadOpen: false,
    globalRulesResult: { status: "absent" },
    projectRulesResult: { status: "absent" },
    snapshot: makeSnapshot("snapshot-index", [
      { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
    ]),
    ...initialBehavior,
  };
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let tool: GuidedToolDefinition | undefined;
  let responseTool: ResponseToolDefinition | undefined;
  const sentMessages: string[] = [];
  const sentMessageMeta: SentMessageMeta[] = [];
  const registeredRenderers: string[] = [];
  const openedSnapshots: string[] = [];
  const openedThreadBatches: string[] = [];
  const appendedEntries: AppendedEntry[] = [];
  const ruleLoadCalls: RuleLoadCall[] = [];
  let sessionStartHandler:
    | ((event: unknown, ctx: unknown) => unknown)
    | undefined;
  const pi = {
    on(eventName: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (eventName === "session_start") {
        sessionStartHandler = handler;
      }
    },
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      assert.equal(name, "diffwalk");
      command = options.handler;
    },
    registerTool(definition: GuidedToolDefinition | ResponseToolDefinition) {
      if (definition.name === REVIEW_RESPONSES_TOOL_NAME) {
        responseTool = definition as ResponseToolDefinition;
      } else {
        tool = definition as GuidedToolDefinition;
      }
    },
    sendMessage(
      message: {
        customType: string;
        content: string;
        display: boolean;
        details?: unknown;
      },
      options?: { triggerTurn?: boolean },
    ) {
      sentMessages.push(message.content);
      sentMessageMeta.push({
        customType: message.customType,
        display: message.display,
        triggerTurn: options?.triggerTurn === true,
      });
    },
    registerMessageRenderer(customType: string) {
      registeredRenderers.push(customType);
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  const dependencies: DiffWalkDependencies = {
    async captureReviewSnapshot(_git, _cwd, targetRef) {
      return {
        ...behavior.snapshot,
        comparison: { ...behavior.snapshot.comparison, targetRef },
      };
    },
    async captureRepositoryState() {
      const state = behavior.snapshot.repositoryState;
      return behavior.submissionDrift
        ? {
            ...state,
            unstagedFingerprint: "drifted" as typeof state.unstagedFingerprint,
          }
        : state;
    },
    async assertReviewSnapshotUnchanged() {
      if (behavior.drift) {
        throw new ReviewSnapshotDriftError("Repository changed.");
      }
    },
    async loadGlobalDiffWalkRules() {
      ruleLoadCalls.push({ scope: "global" });
      if (behavior.globalRulesError !== undefined) {
        throw behavior.globalRulesError;
      }
      return behavior.globalRulesResult;
    },
    async loadProjectDiffWalkRules(repositoryRoot, projectTrusted) {
      ruleLoadCalls.push({ scope: "project", repositoryRoot, projectTrusted });
      if (behavior.projectRulesError !== undefined) {
        throw behavior.projectRulesError;
      }
      return behavior.projectRulesResult;
    },
    async openReviewThreads(_ctx, input) {
      openedThreadBatches.push(input.batch.id);
      const firstThread = input.batch.threads[0];
      assert.ok(firstThread);
      if (behavior.resolveThreadOnOpen && input.batch.turns[0] !== undefined) {
        const resolved = setReviewThreadResolved(
          input.batch,
          firstThread.id,
          true,
        );
        input.onBatchChange(resolved);
        return { status: "closed", batch: resolved };
      }
      if (behavior.submitFollowUpOnThreadOpen) {
        const followedUp = appendReviewThreadTurn(input.batch, {
          submissionMode: "discuss-first",
          replies: [
            {
              threadId: firstThread.id,
              body: "Explain that answer further.",
            },
          ],
        });
        input.onBatchChange(followedUp);
        const turn = followedUp.turns.at(-1);
        assert.ok(turn);
        return {
          status: "follow-up-submitted",
          batch: followedUp,
          turnId: turn.id,
        };
      }
      return { status: "closed", batch: input.batch };
    },
    async openGuidedReview(_ctx, input) {
      openedSnapshots.push(input.review.snapshot.id);
      let review = input.review;
      if (behavior.markProgressOnOpen) {
        const first = review.unitProgress[0];
        if (first !== undefined) {
          review = markReviewUnitReviewed(review, first.reviewUnitId, {
            expectedVersion: review.version,
            timestamp: new Date().toISOString(),
          });
          input.onReviewChange(review);
        }
      }
      if (behavior.discardOnOpen) {
        return { status: "discarded", snapshotId: input.review.snapshot.id };
      }
      if (!behavior.submitOnOpen) {
        return { status: "paused", snapshotId: input.review.snapshot.id };
      }
      if (behavior.commentOnSubmit) {
        const unit = review.route?.units[0];
        const change = review.snapshot.changes[0];
        assert.ok(unit);
        assert.ok(change);
        review = upsertInProgressReviewComment(
          review,
          {
            reviewUnitId: unit.id,
            fileChangeId: change.id,
            side: "new",
            line: 2,
            body: "Check this behavior.",
          },
          {
            expectedVersion: review.version,
            timestamp: new Date().toISOString(),
          },
        );
        input.onReviewChange(review);
      }
      for (const progress of review.unitProgress) {
        review = markReviewUnitReviewed(review, progress.reviewUnitId, {
          expectedVersion: review.version,
          timestamp: new Date().toISOString(),
        });
      }
      input.onReviewChange(review);
      return input.onSubmit(review, new AbortController().signal);
    },
  };

  registerDiffWalk(pi, dependencies);
  assert.ok(command);
  assert.ok(tool);
  assert.ok(responseTool);
  assert.ok(sessionStartHandler);
  const restoreSession = async (
    entries: readonly AppendedEntry[],
  ): Promise<void> => {
    await sessionStartHandler?.(
      { type: "session_start" },
      {
        sessionManager: {
          getEntries: () =>
            entries.map((entry) => ({
              type: "custom",
              customType: entry.customType,
              data: entry.data,
            })),
        },
      },
    );
  };
  return {
    command,
    tool,
    responseTool,
    sentMessages,
    sentMessageMeta,
    registeredRenderers,
    openedSnapshots,
    openedThreadBatches,
    appendedEntries,
    ruleLoadCalls,
    behavior,
    restoreSession,
  };
}

const plainTheme = {
  fg: (_color: ThemeColor, text: string) => text,
} as Pick<Theme, "fg"> as Theme;

function renderedText(
  component: { render(width: number): string[] },
  width: number,
): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

function commandContext(
  mode: ExtensionCommandContext["mode"] = "tui",
  notifications: string[] = [],
  projectTrusted = true,
  cwd = "/repo",
): ExtensionCommandContext {
  return {
    mode,
    cwd,
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
}

function toolContext(): ExtensionContext {
  return { mode: "tui" } as ExtensionContext;
}

function binaryChange(): FileChange {
  return {
    id: "file-change:binary" as FileChangeId,
    source: "tracked",
    status: "modified",
    oldPath: "assets/logo.png",
    newPath: "assets/logo.png",
    gitHeaderLines: [],
    content: {
      type: "binary",
      gitBodyLines: [],
      unsupportedReason: "Binary file.",
    },
  };
}

function modeChange(): FileChange {
  return {
    id: "file-change:mode" as FileChangeId,
    source: "tracked",
    status: "mode-changed",
    oldPath: "scripts/deploy.sh",
    newPath: "scripts/deploy.sh",
    oldMode: "100644",
    newMode: "100755",
    gitHeaderLines: [],
    content: {
      type: "metadata-only",
      gitBodyLines: [],
      unsupportedReason: "This file change has no textual diff hunks.",
    },
  };
}

function commentFixture(): ReviewComment {
  return {
    snapshotId: "snapshot-index" as SnapshotId,
    reviewUnitId: "unit-index" as ReviewComment["reviewUnitId"],
    fileChangeId: "file-index" as ReviewComment["fileChangeId"],
    side: "new",
    line: 2,
    filePath: "src/file.ts",
    oldPath: "src/file.ts",
    newPath: "src/file.ts",
    newLine: 2,
    selectedText: "changed",
    nearbyContext: [{ type: "added", newLine: 2, text: "changed" }],
    body: "Check this behavior.",
  };
}

function validRoute(snapshotId = "snapshot-index"): ReviewRouteCandidate {
  return {
    snapshotId,
    units: [
      {
        title: "Entry point",
        whyHere: "Behavior starts here.",
        context: "entry -> implementation",
        changeSummary: "Updates behavior.",
        reviewFocus: [{ question: "Is the behavior correct?" }],
        spans: [span("src/file.ts", { new: [2, 2] })],
      },
    ],
    skippedSpans: [],
  };
}

type GuidedToolRenderContext = Parameters<
  NonNullable<GuidedToolDefinition["renderResult"]>
>[3];

function toolRenderContext(isError = false): GuidedToolRenderContext {
  return {
    args: validRoute(),
    toolCallId: "call-render",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError,
  };
}

function renderedToolResult(
  tool: GuidedToolDefinition,
  result: Awaited<ReturnType<GuidedToolDefinition["execute"]>>,
  isError = false,
): string {
  assert.ok(tool.renderResult);
  return renderedText(
    tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      plainTheme,
      toolRenderContext(isError),
    ),
    120,
  );
}

function toolResultWithoutDetails(
  message: string,
): Awaited<ReturnType<GuidedToolDefinition["execute"]>> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined as unknown as GuidedReviewResult,
  };
}

test("parses the default and explicit review targets", () => {
  assert.equal(parseReviewTarget(""), "HEAD");
  assert.equal(parseReviewTarget("  \n"), "HEAD");
  assert.equal(parseReviewTarget(" origin/main "), "origin/main");
});

test("separates the discard option from a base revision", () => {
  assert.deepEqual(parseDiffWalkCommand("  "), { type: "review" });
  assert.deepEqual(parseDiffWalkCommand(" origin/main "), {
    type: "review",
    targetRef: "origin/main",
  });
  assert.deepEqual(parseDiffWalkCommand(" --discard "), { type: "discard" });
  assert.deepEqual(parseDiffWalkCommand(" --threads "), { type: "threads" });
  assert.throws(
    () => parseDiffWalkCommand("--drop"),
    /Unknown \/diffwalk option --drop/,
  );
});

test("adapts pi.exec to argument-array Git execution", async () => {
  const calls: unknown[] = [];
  const signal = new AbortController().signal;
  const runner = createPiGitRunner(
    {
      async exec(command, args, options) {
        calls.push({ command, args, options });
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
    },
    signal,
  );

  assert.deepEqual(await runner.run(["status", "--short"], "/repo"), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["status", "--short"],
      options: { cwd: "/repo", signal },
    },
  ]);
});

test("requires /diffwalk and binds the tool route to the pending snapshot", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.tool.execute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending.*run \/diffwalk first/,
  );

  await harness.command(" origin/main ", commandContext());
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /Prepare a semantic route/);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);
  assert.deepEqual(harness.sentMessageMeta[0], {
    customType: DIFFWALK_KICKOFF_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });

  await assert.rejects(
    harness.tool.execute(
      "call-2",
      validRoute("other-snapshot"),
      undefined,
      undefined,
      toolContext(),
    ),
    /does not match pending snapshot snapshot-index/,
  );

  await assert.rejects(
    harness.tool.execute(
      "call-3",
      { ...validRoute(), units: [] },
      undefined,
      undefined,
      toolContext(),
    ),
    /Invalid review route:[\s\S]*src\/file\.ts new 2-2[\s\S]*must contain at least one review unit with spans/,
  );

  const completed = await harness.tool.execute(
    "call-4",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "paused",
    snapshotId: "snapshot-index",
  });
  assert.equal(completed.terminate, true);

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
  assert.equal(harness.sentMessages.length, 1);

  await assert.rejects(
    harness.tool.execute(
      "call-5",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /already has a validated route.*resume it/,
  );
});

test("project rules replace global rules and the selection is captured once", async () => {
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: {
        scope: "global",
        content: "Review security boundaries before callers.",
      },
    },
    projectRulesResult: {
      status: "loaded",
      rules: {
        scope: "project",
        content: "Keep behavioral tests with their implementation.",
      },
    },
  });

  await harness.command(
    "",
    commandContext("tui", [], true, "/repo/packages/service"),
  );
  const firstPrompt = harness.sentMessages[0] ?? "";
  assert.match(
    firstPrompt,
    /Keep behavioral tests with their implementation\./,
  );
  assert.doesNotMatch(
    firstPrompt,
    /Review security boundaries before callers\./,
  );

  harness.behavior.globalRulesResult = {
    status: "loaded",
    rules: { scope: "global", content: "Changed global rules." },
  };
  harness.behavior.projectRulesResult = {
    status: "loaded",
    rules: { scope: "project", content: "Changed project rules." },
  };
  await harness.command("", commandContext());
  assert.equal(harness.sentMessages[1], firstPrompt);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
  ]);
});

test("falls back to global rules when project rules are absent", async () => {
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
  });

  await harness.command("", commandContext());

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("falls back to global rules when project trust suppresses project rules", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesResult: { status: "ignored-untrusted" },
  });

  await harness.command("", commandContext("tui", notifications, false));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.match(notifications[0] ?? "", /project is not trusted/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: false },
    { scope: "global" },
  ]);
});

test("falls back to global rules when a changed project rules file is ignored", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Skip this file." },
    },
    snapshot: makeSnapshot("snapshot-index", [
      {
        path: ".pi/diffwalk/rules.md",
        lines: ["+- Skip this file."],
      },
    ]),
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.doesNotMatch(harness.sentMessages[0] ?? "", /Skip this file/);
  assert.match(notifications[0] ?? "", /cannot shape the review of their own/);
  assert.deepEqual(harness.ruleLoadCalls, [{ scope: "global" }]);
});

test("does not inspect global rules when project rules are selected", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "unavailable",
      reason: "Global DiffWalk rules are too large.",
    },
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Review project contracts first." },
    },
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review project contracts first\./,
  );
  assert.deepEqual(notifications, []);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
  ]);
});

test("falls back to global rules when project rules are unavailable", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review global contracts first." },
    },
    projectRulesResult: {
      status: "unavailable",
      reason: "Project DiffWalk rules are not valid UTF-8.",
    },
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review global contracts first\./,
  );
  assert.match(notifications[0] ?? "", /Continuing without those rules/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("falls back to global rules when the project rules loader rejects", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesError: new Error("Injected project loader failure."),
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.match(notifications[0] ?? "", /Injected project loader failure/);
  assert.match(notifications[0] ?? "", /Continuing without them/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("rejects drift detected after project rules are captured", async () => {
  const harness = createHarness({
    drift: true,
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Review public contracts first." },
    },
  });

  await assert.rejects(
    harness.command("", commandContext()),
    ReviewSnapshotDriftError,
  );
  assert.equal(harness.sentMessages.length, 0);
});

test("terminates the initial tool turn when the review is discarded", async () => {
  const harness = createHarness({ discardOnOpen: true });
  await harness.command("", commandContext());

  const discarded = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  assert.deepEqual(discarded.details, {
    status: "discarded",
    snapshotId: "snapshot-index",
  });
  assert.equal(discarded.terminate, true);
});

test("continues the initial tool turn when a submitted review has comments", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());

  const submitted = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const details = submitted.details as Extract<
    GuidedReviewResult,
    { status: "submitted" }
  >;
  assert.equal(details.status, "submitted");
  assert.equal(details.comments.length, 1);
  assert.equal(submitted.terminate, false);
});

test("accepts complete structured responses and opens anchored threads", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted") throw new Error("Expected submission.");
  assert.ok(result.commentBatchId);
  assert.ok(harness.responseTool.prepareArguments);
  assert.deepEqual(
    harness.responseTool.prepareArguments({
      batchId: result.commentBatchId,
      responses: [{ commentId: "C1", body: "Legacy response." }],
    }),
    {
      batchId: result.commentBatchId,
      turnId: "T1",
      responses: [{ threadId: "C1", body: "Legacy response." }],
    },
  );

  const responses = await harness.responseTool.execute(
    "call-responses",
    {
      batchId: result.commentBatchId,
      turnId: result.commentTurnId ?? "T1",
      responses: [{ threadId: "C1", body: "The behavior is intentional." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(responses.terminate, true);
  assert.equal(
    responses.details?.batch.turns[0]?.items[0]?.agentResponse?.body,
    "The behavior is intentional.",
  );
  assert.deepEqual(harness.openedThreadBatches, [result.commentBatchId]);
  assert.equal(
    harness.appendedEntries.filter(
      (entry) => entry.customType === DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
    ).length,
    2,
  );
});

test("continues the Agent turn when the reviewer submits an inline follow-up", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
    submitFollowUpOnThreadOpen: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }

  const firstResponse = await harness.responseTool.execute(
    "call-responses-1",
    {
      batchId: result.commentBatchId,
      turnId: result.commentTurnId,
      responses: [{ threadId: "C1", body: "Initial answer." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(firstResponse.terminate, false);
  assert.equal(firstResponse.details?.status, "follow-up-submitted");
  assert.equal(
    firstResponse.details?.status === "follow-up-submitted"
      ? firstResponse.details.turnId
      : undefined,
    "T2",
  );
  const followUpPayload = firstResponse.content.find(
    (item) => item.type === "text",
  );
  assert.equal(followUpPayload?.type, "text");
  if (followUpPayload?.type !== "text") throw new Error("Expected text.");
  assert.match(followUpPayload.text, /"turnId":"T2"/);
  assert.match(followUpPayload.text, /Explain that answer further/);
  assert.match(followUpPayload.text, /Initial answer/);

  harness.behavior.submitFollowUpOnThreadOpen = false;
  const secondResponse = await harness.responseTool.execute(
    "call-responses-2",
    {
      batchId: result.commentBatchId,
      turnId: "T2",
      responses: [{ threadId: "C1", body: "Further explanation." }],
    },
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(secondResponse.terminate, true);
  assert.equal(secondResponse.details?.status, "closed");
  assert.equal(
    secondResponse.details?.batch.turns[1]?.items[0]?.agentResponse?.body,
    "Further explanation.",
  );
});

test("carries a reviewer-resolved comment forward in the next round", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
    resolveThreadOnOpen: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted" || result.commentBatchId === undefined) {
    throw new Error("Expected a submitted comment batch.");
  }
  await harness.responseTool.execute(
    "call-responses",
    {
      batchId: result.commentBatchId,
      turnId: result.commentTurnId ?? "T1",
      responses: [{ threadId: "C1", body: "Answered." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+new"] },
  ]);
  await harness.command("", commandContext());

  const kickoff = harness.sentMessages.at(-1) ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.doesNotMatch(kickoff, /"unresolvedComment"[\s\S]*"2"/);
});

test("finishes thread turns before freezing a later review delta", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
  ]);
  await assert.rejects(
    harness.command("", commandContext()),
    /unfinished reviewer turn or draft reply/,
  );

  await harness.responseTool.execute(
    "call-responses",
    {
      batchId: result.commentBatchId,
      turnId: result.commentTurnId,
      responses: [{ threadId: "C1", body: "Answered." }],
    },
    undefined,
    undefined,
    toolContext(),
  );
  await harness.command("", commandContext());
  await assert.rejects(
    harness.command("--threads", commandContext()),
    /baseline of pending review.*Finish or discard/,
  );
});

test("reopens the latest persisted comment threads", async () => {
  const first = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await first.command("", commandContext());
  await first.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const second = createHarness();
  await second.restoreSession(first.appendedEntries);
  await second.command("--threads", commandContext());

  assert.equal(second.openedThreadBatches.length, 1);
});

test("starts an Agent turn for a follow-up submitted from /diffwalk --threads", async () => {
  const first = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await first.command("", commandContext());
  const submitted = await first.tool.execute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }
  await first.responseTool.execute(
    "call-response",
    {
      batchId: result.commentBatchId,
      turnId: result.commentTurnId,
      responses: [{ threadId: "C1", body: "Initial answer." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  const second = createHarness({ submitFollowUpOnThreadOpen: true });
  await second.restoreSession(first.appendedEntries);
  await second.command("--threads", commandContext());

  const meta = second.sentMessageMeta.at(-1);
  assert.deepEqual(meta, {
    customType: DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });
  assert.match(second.sentMessages.at(-1) ?? "", /"turnId":"T2"/);
  assert.match(second.sentMessages.at(-1) ?? "", /Explain that answer further/);
});

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

test("rejects a different explicit base once the human worked in the review", async () => {
  const harness = createHarness({ markProgressOnOpen: true });
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  await assert.rejects(
    harness.command("origin/main", commandContext()),
    /review against HEAD is pending with 0 draft comments and 1 reviewed unit[\s\S]*\/diffwalk --discard to drop it/,
  );

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
});

test("replaces an untouched routed review when the base changes", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const notifications: string[] = [];
  await harness.command("origin/main", commandContext("tui", notifications));

  assert.match(
    notifications[0] ?? "",
    /Replacing the untouched review against HEAD with a review against origin\/main/,
  );
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/main"/);
});

test("discards a pending review without opening the walkthrough", async () => {
  const harness = createHarness();
  const notifications: string[] = [];
  await harness.command("--discard", commandContext("tui", notifications));
  assert.deepEqual(notifications, ["No DiffWalk review is pending."]);

  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  await harness.command("--discard", commandContext("tui", notifications));
  assert.match(
    notifications[1] ?? "",
    /Discarded the pending DiffWalk review against HEAD and 0 draft comments/,
  );

  await harness.command("origin/main", commandContext("tui", notifications));
  assert.equal(notifications.length, 2);
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/main"/);
});

test("discards a drifted paused review and starts a new one", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.drift = true;
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0] ?? "",
    /repository changed while the review[\s\S]*Discarded the stale review and 0 draft comments/,
  );
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /Prepare a semantic route/);
  assert.deepEqual(harness.openedSnapshots, ["snapshot-index"]);
});

test("replaces an unrouted pending review when the target changes or drifts", async () => {
  const harness = createHarness();
  const notifications: string[] = [];
  await harness.command("origin/main", commandContext("tui", notifications));
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);

  await harness.command("origin/release", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0] ?? "",
    /Replacing the pending review against origin\/main/,
  );
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/release"/);

  await harness.command("origin/release", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.equal(harness.sentMessages.length, 3);
  assert.match(harness.sentMessages[2] ?? "", /"targetRef": "origin\/release"/);

  harness.behavior.drift = true;
  await harness.command("", commandContext("tui", notifications));
  assert.equal(notifications.length, 2);
  assert.match(notifications[1] ?? "", /Capturing a new snapshot/);
  assert.match(harness.sentMessages[3] ?? "", /"targetRef": "origin\/release"/);
});

test("returns advisory signals once, then accepts the resubmitted route", async () => {
  const movedBlock = [
    "const total = computeTotalAmount(items);",
    "const tax = totalAmount * currentTaxRate;",
    "return { totalAmount, taxAmount: tax };",
  ];
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-index", [
      {
        path: "src/from.ts",
        lines: [" head", ...movedBlock.map((line) => `-${line}`), " tail"],
      },
      {
        path: "src/to.ts",
        lines: [" top", ...movedBlock.map((line) => `+${line}`), " bottom"],
      },
    ]),
  });
  await harness.command("", commandContext());
  assert.match(
    harness.sentMessages[0] ?? "",
    /`moves` lists exact relocations/,
  );

  const splitRoute: ReviewRouteCandidate = {
    snapshotId: "snapshot-index",
    units: [
      {
        title: "Removal",
        whyHere: "Old site first.",
        context: "from -> to",
        changeSummary: "Removes the block.",
        reviewFocus: [{ question: "Is the removal safe?" }],
        spans: [span("src/from.ts", { old: [2, 4] })],
      },
      {
        title: "Addition",
        whyHere: "New site second.",
        context: "from -> to",
        changeSummary: "Adds the block.",
        reviewFocus: [{ question: "Is the addition safe?" }],
        spans: [span("src/to.ts", { new: [2, 4] })],
      },
    ],
    skippedSpans: [],
  };

  let advisoryMessage: string | undefined;
  await assert.rejects(
    harness.tool.execute(
      "call-1",
      splitRoute,
      undefined,
      undefined,
      toolContext(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      advisoryMessage = error.message;
      assert.equal(error.name, "ReviewRouteAdvisoryNudge");
      assert.match(error.message, /exact relocation/);
      assert.match(error.message, /advisory signals, not validation failures/);
      return true;
    },
  );
  assert.ok(advisoryMessage);
  const renderedAdvisory = renderedToolResult(
    harness.tool,
    toolResultWithoutDetails(advisoryMessage),
    true,
  );
  assert.doesNotMatch(renderedAdvisory, /needs attention/);
  assert.match(renderedAdvisory, /advisory signals, not validation failures/);
  assert.doesNotMatch(
    renderedAdvisory,
    /snapshotId|submissionMode|instruction/,
  );
  assert.deepEqual(harness.openedSnapshots, []);

  const completed = await harness.tool.execute(
    "call-2",
    splitRoute,
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "paused",
    snapshotId: "snapshot-index",
  });
  assert.deepEqual(harness.openedSnapshots, ["snapshot-index"]);
});

test("rejects repository drift before opening the walkthrough", async () => {
  const harness = createHarness({ drift: true });
  await harness.command("", commandContext());

  let driftMessage: string | undefined;
  await assert.rejects(
    harness.tool.execute(
      "call-drift",
      validRoute(),
      new AbortController().signal,
      undefined,
      toolContext(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSnapshotDriftError);
      driftMessage = error.message;
      assert.match(
        error.message,
        /Run \/diffwalk again before opening DiffWalk/,
      );
      return true;
    },
  );
  assert.ok(driftMessage);
  const renderedDrift = renderedToolResult(
    harness.tool,
    toolResultWithoutDetails(driftMessage),
    true,
  );
  assert.doesNotMatch(renderedDrift, /needs attention/);
  assert.match(renderedDrift, /Run \/diffwalk again before opening DiffWalk/);
  assert.doesNotMatch(renderedDrift, /snapshotId|submissionMode|instruction/);
  assert.deepEqual(harness.openedSnapshots, []);

  await assert.rejects(
    harness.tool.execute(
      "call-stale",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending/,
  );
});

test("submits through the domain pipeline against the captured repository state", async () => {
  const harness = createHarness({ submissionDrift: true });
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());

  await assert.rejects(
    harness.tool.execute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /no longer matches review snapshot/,
  );
});

test("keeps completed rounds in memory as the next delta baseline", async () => {
  const harness = createHarness();
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  assert.match(harness.sentMessages[0] ?? "", /"needsReviewLineCount": 1/);

  const submitted = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const details = submitted.details as { readonly status: string };
  assert.equal(details.status, "submitted");
  assert.equal(submitted.terminate, true);

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await harness.command("", commandContext());
  const kickoff = harness.sentMessages.at(-1) ?? "";
  assert.equal(harness.sentMessages.length, 2);
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.match(kickoff, /"baselineRoundId": "review-round:/);
});

test("persists submitted rounds and restores the baseline on session start", async () => {
  const first = createHarness();
  first.behavior.submitOnOpen = true;
  await first.command("", commandContext());
  await first.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(first.appendedEntries.length, 1);
  assert.equal(
    first.appendedEntries[0]?.customType,
    DIFFWALK_SERIES_ENTRY_TYPE,
  );

  const second = createHarness();
  await second.restoreSession(first.appendedEntries);
  second.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await second.command("", commandContext());

  const kickoff = second.sentMessages[0] ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.match(kickoff, /"baselineRoundId": "review-round:/);
});

test("the latest persisted entry for a series wins on restore", async () => {
  const first = createHarness();
  first.behavior.submitOnOpen = true;
  await first.command("", commandContext());
  await first.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  first.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await first.command("", commandContext());
  await first.tool.execute(
    "call-2",
    {
      ...validRoute("snapshot-round-2"),
      units: [
        {
          title: "Appended line",
          whyHere: "Only new line this round.",
          context: "tail -> appended",
          changeSummary: "Appends a line.",
          reviewFocus: [{ question: "Is the appended line correct?" }],
          spans: [span("src/file.ts", { new: [4, 4] })],
        },
      ],
    },
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(first.appendedEntries.length, 2);

  const third = createHarness();
  await third.restoreSession(first.appendedEntries);
  third.behavior.snapshot = makeSnapshot("snapshot-round-3", [
    {
      path: "src/file.ts",
      lines: [" head", "+changed", " tail", "+appended", "+third"],
    },
  ]);
  await third.command("", commandContext());

  const kickoff = third.sentMessages[0] ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 2/);
});

test("ignores incompatible or corrupt persisted entries", async () => {
  const harness = createHarness();
  await harness.restoreSession([
    { customType: DIFFWALK_SERIES_ENTRY_TYPE, data: { formatVersion: 99 } },
    { customType: DIFFWALK_SERIES_ENTRY_TYPE, data: "garbage" },
    { customType: "unrelated-extension", data: { anything: true } },
  ]);

  await harness.command("", commandContext());
  const kickoff = harness.sentMessages[0] ?? "";
  assert.match(kickoff, /"baselineRoundId": null/);
  assert.match(kickoff, /"carriedForwardLineCount": 0/);
});

test("reports a comparison with nothing to review instead of starting one", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-clean", []),
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(harness.sentMessages, []);
  assert.deepEqual(harness.openedSnapshots, []);
  assert.match(
    notifications[0] ?? "",
    /No line needs review against HEAD\. The worktree matches the comparison\./,
  );

  harness.behavior.snapshot = makeSnapshot("snapshot-index", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
  ]);
  await harness.command("origin/main", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);
});

test("names carried-forward, unreviewable, and noticed changes when nothing needs review", async () => {
  const harness = createHarness();
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.snapshot = makeSnapshot(
    "snapshot-carried",
    [{ path: "src/file.ts", lines: [" head", "+changed", " tail"] }],
    {
      changes: [binaryChange()],
      notices: [
        {
          id: "notice-1" as NoticeId,
          type: "cancelled-layer-change",
          message: "A submodule change was not reviewed.",
        },
      ],
    },
  );
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.equal(harness.sentMessages.length, 1);
  assert.match(
    notifications[0] ?? "",
    /No line needs review against HEAD\. 1 changed line already reviewed in round 1\. assets\/logo\.png cannot be reviewed line by line: Binary file\. A submodule change was not reviewed\./,
  );
});

test("fails /diffwalk clearly outside interactive TUI mode", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.command("", commandContext("print")),
    /requires interactive TUI mode; current mode is print/,
  );
  assert.deepEqual(harness.sentMessages, []);
});

test("completes a resumed review with no comments without messaging the agent", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.submitOnOpen = true;
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(
    harness.sentMessageMeta.map((meta) => meta.customType),
    [DIFFWALK_KICKOFF_MESSAGE_TYPE],
  );
  assert.equal(harness.appendedEntries.length, 1);
  assert.deepEqual(notifications, [
    "Review complete. No comments submitted. No agent follow-up needed.",
  ]);
});

test("reports resumed pauses and discards with the tool outcome wording", async () => {
  const pausedHarness = createHarness();
  await pausedHarness.command("", commandContext());
  await pausedHarness.tool.execute(
    "call-paused",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const pausedNotifications: string[] = [];
  await pausedHarness.command("", commandContext("tui", pausedNotifications));
  assert.deepEqual(pausedNotifications, [
    "Review paused. Progress and draft comments remain resumable while the snapshot matches. Repository changes are allowed; the next /diffwalk discards a stale review and starts over.",
  ]);

  const discardedHarness = createHarness();
  await discardedHarness.command("", commandContext());
  await discardedHarness.tool.execute(
    "call-discarded",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  discardedHarness.behavior.discardOnOpen = true;
  const discardedNotifications: string[] = [];
  await discardedHarness.command(
    "",
    commandContext("tui", discardedNotifications),
  );
  assert.deepEqual(discardedNotifications, [
    "Review discarded. Progress and draft comments removed.",
  ]);
});

test("sends a resumed submission result when comments need an agent response", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.submitOnOpen = true;
  harness.behavior.commentOnSubmit = true;
  await harness.command("", commandContext());

  assert.deepEqual(
    harness.sentMessageMeta.map((meta) => meta.customType),
    [DIFFWALK_KICKOFF_MESSAGE_TYPE, DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE],
  );
  assert.deepEqual(harness.sentMessageMeta[1], {
    customType: DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });
  assert.match(harness.sentMessages[1] ?? "", /"status":"submitted"/);
  assert.match(harness.sentMessages[1] ?? "", /Check this behavior/);
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
