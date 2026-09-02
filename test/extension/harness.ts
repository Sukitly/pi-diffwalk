import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { DiffWalkRulesLoadResult } from "../../src/extension/rules.ts";
import type { DiffWalkDependencies } from "../../src/extension/session.ts";
import { ReviewSnapshotDriftError } from "../../src/git/errors.ts";
import { registerDiffWalk } from "../../src/index.ts";
import {
  markReviewUnitReviewed,
  upsertInProgressReviewComment,
} from "../../src/review/in-progress.ts";
import {
  appendReviewThreadTurn,
  REVIEW_RESPONSES_TOOL_NAME,
  type ReviewResponseCandidateSchema,
  setReviewThreadResolved,
} from "../../src/review/threads.ts";
import type {
  FileChange,
  FileChangeId,
  GuidedReviewResult,
  ReviewComment,
  ReviewRouteCandidate,
  ReviewRouteCandidateSchema,
  ReviewSnapshot,
  SnapshotId,
} from "../../src/review/types.ts";
import type { ReviewThreadUiResult } from "../../src/thread-ui/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

export type GuidedToolDefinition = ToolDefinition<
  typeof ReviewRouteCandidateSchema,
  GuidedReviewResult
>;

export type ResponseToolDefinition = ToolDefinition<
  typeof ReviewResponseCandidateSchema,
  ReviewThreadUiResult
>;

export interface HarnessBehavior {
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

export interface SentMessageMeta {
  readonly customType: string;
  readonly display: boolean;
  readonly triggerTurn: boolean;
}

export interface AppendedEntry {
  readonly customType: string;
  readonly data: unknown;
}

export type RuleLoadCall =
  | { readonly scope: "global" }
  | {
      readonly scope: "project";
      readonly repositoryRoot: string;
      readonly projectTrusted: boolean;
    };

export interface Harness {
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

export function createHarness(
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

export const plainTheme = {
  fg: (_color: ThemeColor, text: string) => text,
} as Pick<Theme, "fg"> as Theme;

export function renderedText(
  component: { render(width: number): string[] },
  width: number,
): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

export function commandContext(
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

export function toolContext(): ExtensionContext {
  return { mode: "tui" } as ExtensionContext;
}

export function binaryChange(): FileChange {
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

export function modeChange(): FileChange {
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

export function commentFixture(): ReviewComment {
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

export function validRoute(
  snapshotId = "snapshot-index",
): ReviewRouteCandidate {
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

export type GuidedToolRenderContext = Parameters<
  NonNullable<GuidedToolDefinition["renderResult"]>
>[3];

export function toolRenderContext(isError = false): GuidedToolRenderContext {
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

export function renderedToolResult(
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

export function toolResultWithoutDetails(
  message: string,
): Awaited<ReturnType<GuidedToolDefinition["execute"]>> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined as unknown as GuidedReviewResult,
  };
}
