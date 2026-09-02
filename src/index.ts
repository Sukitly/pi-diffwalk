import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  buildReviewKickoffPrompt,
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
  GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
} from "./extension/prompts.ts";
import {
  DIFFWALK_RULES_SOURCE,
  type DiffWalkRulesLoadResult,
  type DiffWalkRulesScope,
  type LoadedDiffWalkRules,
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
} from "./extension/rules.ts";
import {
  assertReviewSnapshotUnchanged,
  captureRepositoryState,
  captureReviewSnapshot,
  type GitRunner,
  ReviewSnapshotDriftError,
} from "./git/snapshot.ts";
import { computeReviewDelta } from "./review/delta.ts";
import {
  attachReviewRoute,
  createInProgressReview,
  discardInProgressReview,
  submitInProgressReview,
} from "./review/in-progress.ts";
import { detectExactMoves } from "./review/moves.ts";
import {
  DIFFWALK_SERIES_ENTRY_TYPE,
  parseReviewSeriesEntry,
  serializeReviewSeriesEntry,
} from "./review/persistence.ts";
import {
  assessRouteQuality,
  ReviewRouteAdvisoryNudge,
} from "./review/route-advisory.ts";
import { validateReviewRoute } from "./review/route-validation.ts";
import { createReviewSeries } from "./review/series.ts";
import {
  DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
  parseReviewThreadBatchEntry,
  serializeReviewThreadBatchEntry,
} from "./review/thread-persistence.ts";
import {
  attachReviewThreadResponses,
  createReviewThreadBatch,
  isReviewThreadBatchAnswered,
  pendingReviewThreadTurn,
  REVIEW_RESPONSES_TOOL_DESCRIPTION,
  REVIEW_RESPONSES_TOOL_NAME,
  REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET,
  type ReviewResponseCandidate,
  ReviewResponseCandidateSchema,
  resolvedCommentLines,
  reviewThreadConversation,
} from "./review/threads.ts";
import {
  type GuidedReviewResult,
  type InProgressReview,
  type ReviewDelta,
  ReviewRouteCandidateSchema,
  type ReviewSeries,
  type ReviewSeriesId,
  type ReviewSnapshot,
  type ReviewSubmissionMode,
  type ReviewThreadBatch,
  type ReviewThreadBatchId,
  type ReviewThreadTurnId,
  type SubmittedGuidedReviewResult,
} from "./review/types.ts";
import { openGuidedReview } from "./review-ui/component.ts";
import {
  openReviewThreads,
  type ReviewThreadUiResult,
} from "./thread-ui/component.ts";

const DEFAULT_REVIEW_TARGET = "HEAD";
const DISCARD_OPTION = "--discard";
const THREADS_OPTION = "--threads";

/**
 * Kickoff and submission payloads reach the LLM verbatim. The TUI renders
 * separate user-facing facts and keeps protocol details out of the transcript.
 */
export const DIFFWALK_KICKOFF_MESSAGE_TYPE = "diffwalk-kickoff";
export const DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE = "diffwalk-review-result";
export const DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE =
  "diffwalk-thread-follow-up";

export interface KickoffAdditionalChangeDetails {
  readonly path: string;
  readonly description: string;
}

/** User-facing facts rendered in the TUI instead of the kickoff prompt. */
export interface KickoffMessageDetails {
  readonly targetRef: string;
  readonly changedFileCount: number;
  readonly needsReviewLineCount: number;
  readonly carriedForwardLineCount: number;
  readonly additionalChanges?: readonly KickoffAdditionalChangeDetails[];
}

/** User-facing facts rendered in the TUI instead of the submission payload. */
export interface SubmittedReviewMessageDetails {
  readonly submissionMode: ReviewSubmissionMode;
  readonly commentCount: number;
}

export interface ThreadFollowUpMessageDetails {
  readonly submissionMode: ReviewSubmissionMode;
  readonly replyCount: number;
}

type CommandContext = Pick<
  ExtensionCommandContext,
  "cwd" | "isProjectTrusted" | "ui"
>;

interface PendingReview {
  review: InProgressReview;
  series: ReviewSeries;
  inProgress: boolean;
  /** The selected rules file is captured once so repeated kickoffs stay deterministic. */
  routeRules?: LoadedDiffWalkRules;
  /** Advisory route-quality signals are returned at most once per review. */
  advisoryNudged: boolean;
}

export function parseReviewTarget(args: string): string {
  const target = args.trim();
  return target.length === 0 ? DEFAULT_REVIEW_TARGET : target;
}

/**
 * `/diffwalk` takes either a base revision or an option.
 *
 * A Git revision cannot start with `-`, so an option can never shadow a base
 * the user meant to review.
 */
export type DiffWalkCommand =
  | { readonly type: "review"; readonly targetRef?: string }
  | { readonly type: "discard" }
  | { readonly type: "threads" };

export function parseDiffWalkCommand(args: string): DiffWalkCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { type: "review" };
  if (trimmed === DISCARD_OPTION) return { type: "discard" };
  if (trimmed === THREADS_OPTION) return { type: "threads" };
  if (trimmed.startsWith("-")) {
    throw new Error(
      `Unknown /diffwalk option ${trimmed}. Use /diffwalk [base] to review a revision, /diffwalk ${THREADS_OPTION} to reopen comment threads, or /diffwalk ${DISCARD_OPTION} to drop a pending review.`,
    );
  }
  return { type: "review", targetRef: parseReviewTarget(trimmed) };
}

export function createPiGitRunner(
  pi: Pick<ExtensionAPI, "exec">,
  signal?: AbortSignal,
): GitRunner {
  return {
    async run(args, cwd) {
      const result: ExecResult = await pi.exec("git", [...args], {
        cwd,
        signal,
      });
      return result;
    },
  };
}

export interface DiffWalkDependencies {
  readonly captureReviewSnapshot: typeof captureReviewSnapshot;
  readonly captureRepositoryState: typeof captureRepositoryState;
  readonly assertReviewSnapshotUnchanged: typeof assertReviewSnapshotUnchanged;
  readonly loadGlobalDiffWalkRules: typeof loadGlobalDiffWalkRules;
  readonly loadProjectDiffWalkRules: typeof loadProjectDiffWalkRules;
  readonly openGuidedReview: typeof openGuidedReview;
  readonly openReviewThreads: typeof openReviewThreads;
}

const DEFAULT_DEPENDENCIES: DiffWalkDependencies = {
  captureReviewSnapshot,
  captureRepositoryState,
  assertReviewSnapshotUnchanged,
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
  openGuidedReview,
  openReviewThreads,
};

export default function diffWalk(pi: ExtensionAPI): void {
  registerDiffWalk(pi);
}

export function registerDiffWalk(
  pi: ExtensionAPI,
  dependencies: DiffWalkDependencies = DEFAULT_DEPENDENCIES,
): void {
  let pendingReview: PendingReview | undefined;
  const completedSeriesById = new Map<ReviewSeriesId, ReviewSeries>();
  const threadBatchesById = new Map<ReviewThreadBatchId, ReviewThreadBatch>();
  let latestThreadBatchId: ReviewThreadBatchId | undefined;

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === DIFFWALK_SERIES_ENTRY_TYPE) {
        const series = parseReviewSeriesEntry(entry.data);
        if (series !== undefined) completedSeriesById.set(series.id, series);
        continue;
      }
      if (entry.customType === DIFFWALK_THREAD_BATCH_ENTRY_TYPE) {
        const batch = parseReviewThreadBatchEntry(entry.data);
        if (batch === undefined) continue;
        threadBatchesById.set(batch.id, batch);
        latestThreadBatchId = batch.id;
      }
    }
  });

  pi.registerMessageRenderer<KickoffMessageDetails>(
    DIFFWALK_KICKOFF_MESSAGE_TYPE,
    renderKickoffMessage,
  );
  pi.registerMessageRenderer<SubmittedReviewMessageDetails>(
    DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    renderSubmittedReviewMessage,
  );
  pi.registerMessageRenderer<ThreadFollowUpMessageDetails>(
    DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
    renderThreadFollowUpMessage,
  );

  function persistThreadBatch(batch: ReviewThreadBatch): void {
    threadBatchesById.set(batch.id, batch);
    latestThreadBatchId = batch.id;
    pi.appendEntry(
      DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
      serializeReviewThreadBatchEntry(batch),
    );
  }

  function snapshotForThreadBatch(batch: ReviewThreadBatch): ReviewSnapshot {
    const series = completedSeriesById.get(batch.seriesId);
    const round = series?.rounds.find(
      (candidate) => candidate.id === batch.roundId,
    );
    if (round === undefined || round.snapshot.id !== batch.snapshotId) {
      throw new Error(
        `Cannot find frozen snapshot ${batch.snapshotId} for DiffWalk thread batch ${batch.id}.`,
      );
    }
    return round.snapshot;
  }

  function assertThreadBatchCanChange(batch: ReviewThreadBatch): void {
    if (pendingReview?.review.delta.baselineRoundId === batch.roundId) {
      throw new Error(
        `DiffWalk thread batch ${batch.id} is the baseline of pending review ${pendingReview.review.id}. Finish or discard that review before changing thread resolution.`,
      );
    }
  }

  async function openThreadBatch(
    ctx: Pick<ExtensionContext, "mode" | "ui">,
    batch: ReviewThreadBatch,
  ): Promise<ReviewThreadUiResult> {
    assertThreadBatchCanChange(batch);
    const result = await dependencies.openReviewThreads(ctx, {
      snapshot: snapshotForThreadBatch(batch),
      batch,
      onBatchChange: persistThreadBatch,
    });
    threadBatchesById.set(result.batch.id, result.batch);
    latestThreadBatchId = result.batch.id;
    return result;
  }

  function sendThreadFollowUp(result: ReviewThreadUiResult): void {
    if (result.status !== "follow-up-submitted") return;
    const turn = requireThreadTurn(result.batch, result.turnId);
    pi.sendMessage(
      {
        customType: DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
        content: formatReviewThreadFollowUp(result.batch, result.turnId),
        display: true,
        details: {
          submissionMode: turn.submissionMode,
          replyCount: turn.items.length,
        },
      },
      { triggerTurn: true },
    );
  }

  function sendKickoffPrompt(pending: PendingReview): void {
    const { delta, snapshot } = pending.review;
    pi.sendMessage(
      {
        customType: DIFFWALK_KICKOFF_MESSAGE_TYPE,
        content: buildReviewKickoffPrompt(snapshot, delta, pending.routeRules),
        display: true,
        details: buildKickoffMessageDetails(snapshot, delta),
      },
      { triggerTurn: true },
    );
  }

  async function captureRulesSource(
    ctx: CommandContext,
    scope: DiffWalkRulesScope,
    load: () => Promise<DiffWalkRulesLoadResult>,
  ): Promise<LoadedDiffWalkRules | undefined> {
    let result: DiffWalkRulesLoadResult;
    try {
      result = await load();
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot load ${scope} DiffWalk rules: ${errorMessage(error)} Continuing without them.`,
        "warning",
      );
      return undefined;
    }

    if (result.status === "absent") return undefined;
    if (result.status === "ignored-untrusted") {
      ctx.ui.notify(
        `Ignored ${DIFFWALK_RULES_SOURCE} because the project is not trusted.`,
        "warning",
      );
      return undefined;
    }
    if (result.status === "unavailable") {
      ctx.ui.notify(
        `${result.reason} Continuing without those rules.`,
        "warning",
      );
      return undefined;
    }
    return result.rules;
  }

  async function captureRouteRules(
    ctx: CommandContext,
    snapshot: ReviewSnapshot,
  ): Promise<LoadedDiffWalkRules | undefined> {
    const projectRulesChanged = snapshot.changes.some(
      (change) =>
        change.oldPath === DIFFWALK_RULES_SOURCE ||
        change.newPath === DIFFWALK_RULES_SOURCE,
    );
    if (projectRulesChanged) {
      ctx.ui.notify(
        `Ignored ${DIFFWALK_RULES_SOURCE} because it is part of snapshot ${snapshot.id}. Project rules cannot shape the review of their own changes.`,
        "warning",
      );
    } else {
      const projectRules = await captureRulesSource(ctx, "project", () =>
        dependencies.loadProjectDiffWalkRules(
          snapshot.repositoryRoot,
          ctx.isProjectTrusted(),
        ),
      );
      if (projectRules !== undefined) {
        await verifySnapshot(
          pi,
          dependencies.assertReviewSnapshotUnchanged,
          snapshot,
          new AbortController().signal,
        );
        return projectRules;
      }
    }

    return captureRulesSource(ctx, "global", () =>
      dependencies.loadGlobalDiffWalkRules(),
    );
  }

  async function startNewReview(
    ctx: CommandContext,
    targetRef: string,
  ): Promise<void> {
    const snapshot = await dependencies.captureReviewSnapshot(
      createPiGitRunner(pi),
      ctx.cwd,
      targetRef,
    );
    const sourceBranch =
      snapshot.comparison.sourceBranch ??
      `detached:${snapshot.comparison.sourceHeadOid}`;
    const createdSeries = createReviewSeries({
      repositoryRoot: snapshot.repositoryRoot,
      sourceBranch,
      targetRef,
    });
    const series = completedSeriesById.get(createdSeries.id) ?? createdSeries;
    const baseline = series.rounds.at(-1);
    const baselineThreads =
      baseline === undefined
        ? undefined
        : [...threadBatchesById.values()].find(
            (batch) => batch.roundId === baseline.id,
          );
    if (
      baselineThreads !== undefined &&
      (!isReviewThreadBatchAnswered(baselineThreads) ||
        baselineThreads.threads.some(
          (thread) => thread.draftReply !== undefined,
        ))
    ) {
      throw new Error(
        `DiffWalk thread batch ${baselineThreads.id} has an unfinished reviewer turn or draft reply. Finish or delete it before starting another review.`,
      );
    }
    const delta = computeReviewDelta(snapshot, baseline, {
      resolvedCommentLines:
        baselineThreads === undefined
          ? []
          : resolvedCommentLines(baselineThreads),
    });
    if (
      !delta.lines.some((requirement) => requirement.type === "needs-review")
    ) {
      pendingReview = undefined;
      ctx.ui.notify(
        describeNothingToReview(snapshot, delta, series, targetRef),
        "info",
      );
      return;
    }
    const routeRules = await captureRouteRules(ctx, snapshot);
    const review = createInProgressReview({
      series,
      snapshot,
      delta,
      timestamp: new Date().toISOString(),
    });
    const pending: PendingReview = {
      review,
      series,
      inProgress: false,
      ...(routeRules === undefined ? {} : { routeRules }),
      advisoryNudged: false,
    };
    pendingReview = pending;
    sendKickoffPrompt(pending);
  }

  async function submitPendingReview(
    pending: PendingReview,
    review: InProgressReview,
    signal: AbortSignal,
  ): Promise<SubmittedGuidedReviewResult> {
    signal.throwIfAborted();
    const currentRepositoryState = await dependencies.captureRepositoryState(
      createPiGitRunner(pi, signal),
      review.snapshot.repositoryRoot,
    );
    signal.throwIfAborted();
    const submitted = submitInProgressReview(
      review,
      pending.series,
      currentRepositoryState,
      {
        expectedVersion: review.version,
        timestamp: new Date().toISOString(),
      },
    );
    pending.review = submitted.review;
    pending.series = submitted.series;
    completedSeriesById.set(submitted.series.id, submitted.series);
    pi.appendEntry(
      DIFFWALK_SERIES_ENTRY_TYPE,
      serializeReviewSeriesEntry(submitted.series),
    );
    const commentBatch =
      review.comments.length === 0
        ? undefined
        : createReviewThreadBatch({
            seriesId: submitted.series.id,
            roundId: submitted.round.id,
            snapshotId: review.snapshot.id,
            submissionMode: review.submissionMode,
            comments: review.comments,
          });
    if (commentBatch !== undefined) persistThreadBatch(commentBatch);
    const initialCommentTurn = commentBatch?.turns[0];
    if (commentBatch !== undefined && initialCommentTurn === undefined) {
      throw new Error(
        `DiffWalk thread batch ${commentBatch.id} has no initial turn.`,
      );
    }
    return {
      status: "submitted",
      snapshotId: review.snapshot.id,
      submissionMode: review.submissionMode,
      comments: review.comments,
      ...(commentBatch === undefined || initialCommentTurn === undefined
        ? {}
        : {
            commentBatchId: commentBatch.id,
            commentTurnId: initialCommentTurn.id,
          }),
    };
  }

  async function runPendingReview(
    ctx: Pick<ExtensionContext, "mode" | "ui">,
    pending: PendingReview,
  ): Promise<GuidedReviewResult> {
    pending.inProgress = true;
    try {
      const result = await dependencies.openGuidedReview(ctx, {
        review: pending.review,
        onReviewChange: (review) => {
          pending.review = review;
        },
        onSubmit: (review, signal) =>
          submitPendingReview(pending, review, signal),
      });
      if (result.status === "submitted" || result.status === "discarded") {
        pendingReview = undefined;
      }
      return result;
    } finally {
      pending.inProgress = false;
    }
  }

  function discardPendingReview(ctx: CommandContext): void {
    const existing = pendingReview;
    if (existing === undefined) {
      ctx.ui.notify("No DiffWalk review is pending.", "info");
      return;
    }
    if (existing.inProgress) {
      throw new Error(
        `Review ${existing.review.id} is open. Discard it from the walkthrough.`,
      );
    }
    discardInProgressReview(existing.review, {
      expectedVersion: existing.review.version,
      timestamp: new Date().toISOString(),
    });
    pendingReview = undefined;
    ctx.ui.notify(
      `Discarded the pending DiffWalk review against ${existing.series.targetRef} and ${describeDrafts(existing.review)}.`,
      "info",
    );
  }

  pi.registerCommand("diffwalk", {
    description: "Start or resume a guided review of the current Git changes",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        throw new Error(
          `DiffWalk requires interactive TUI mode; current mode is ${ctx.mode}.`,
        );
      }

      const command = parseDiffWalkCommand(args);
      if (command.type === "discard") {
        discardPendingReview(ctx);
        return;
      }
      if (command.type === "threads") {
        const batch =
          latestThreadBatchId === undefined
            ? undefined
            : threadBatchesById.get(latestThreadBatchId);
        if (batch === undefined) {
          ctx.ui.notify("No DiffWalk comment threads are available.", "info");
          return;
        }
        const result = await openThreadBatch(ctx, batch);
        sendThreadFollowUp(result);
        return;
      }

      const requestedTarget = command.targetRef;
      const existing = pendingReview;
      if (existing?.review.lifecycle === "ready") {
        if (existing.inProgress) {
          throw new Error(`Review ${existing.review.id} is already open.`);
        }
        const pendingTarget = existing.series.targetRef;
        if (
          requestedTarget !== undefined &&
          requestedTarget !== pendingTarget
        ) {
          if (hasReviewProgress(existing.review)) {
            throw new Error(
              `A DiffWalk review against ${pendingTarget} is pending with ${describeDrafts(existing.review)} and ${describeReviewedUnits(existing.review)}. ` +
                `Run /diffwalk without arguments to resume it, or /diffwalk ${DISCARD_OPTION} to drop it before reviewing against ${requestedTarget}.`,
            );
          }
          pendingReview = undefined;
          ctx.ui.notify(
            `Replacing the untouched review against ${pendingTarget} with a review against ${requestedTarget}.`,
            "info",
          );
          await startNewReview(ctx, requestedTarget);
          return;
        }
        try {
          await verifySnapshot(
            pi,
            dependencies.assertReviewSnapshotUnchanged,
            existing.review.snapshot,
            new AbortController().signal,
          );
        } catch (error: unknown) {
          if (!(error instanceof ReviewSnapshotDriftError)) throw error;
          pendingReview = undefined;
          ctx.ui.notify(
            `The repository changed while the review of snapshot ${existing.review.snapshot.id} was paused. ` +
              `Discarded the stale review and ${describeDrafts(existing.review)}. Starting a new review against ${requestedTarget ?? pendingTarget}.`,
            "warning",
          );
          await startNewReview(ctx, requestedTarget ?? pendingTarget);
          return;
        }
        const result = await runPendingReview(ctx, existing);
        if (result.status === "submitted" && shouldSendReviewToAgent(result)) {
          pi.sendMessage(
            {
              customType: DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
              content: formatGuidedReviewResult(result),
              display: true,
              details: buildSubmittedReviewMessageDetails(result),
            },
            { triggerTurn: true },
          );
        } else {
          ctx.ui.notify(reviewOutcomeNotification(result), "info");
        }
        return;
      }
      if (existing?.review.lifecycle === "preparing-route") {
        const pendingTarget = existing.series.targetRef;
        let drifted = false;
        try {
          await verifySnapshot(
            pi,
            dependencies.assertReviewSnapshotUnchanged,
            existing.review.snapshot,
            new AbortController().signal,
          );
        } catch (error: unknown) {
          if (!(error instanceof ReviewSnapshotDriftError)) throw error;
          drifted = true;
        }
        if (
          drifted ||
          (requestedTarget !== undefined && requestedTarget !== pendingTarget)
        ) {
          pendingReview = undefined;
          ctx.ui.notify(
            drifted
              ? `The repository changed before a route was prepared for snapshot ${existing.review.snapshot.id}. Capturing a new snapshot.`
              : `Replacing the pending review against ${pendingTarget} with a review against ${requestedTarget}.`,
            "info",
          );
          await startNewReview(ctx, requestedTarget ?? pendingTarget);
          return;
        }
        sendKickoffPrompt(existing);
        return;
      }

      await startNewReview(ctx, requestedTarget ?? DEFAULT_REVIEW_TARGET);
    },
  });

  pi.registerTool<typeof ReviewResponseCandidateSchema, ReviewThreadUiResult>({
    name: REVIEW_RESPONSES_TOOL_NAME,
    label: "DiffWalk Responses",
    description: REVIEW_RESPONSES_TOOL_DESCRIPTION,
    promptSnippet: REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET,
    parameters: ReviewResponseCandidateSchema,
    executionMode: "sequential",
    prepareArguments(args): ReviewResponseCandidate {
      const original = args as ReviewResponseCandidate;
      if (args === null || typeof args !== "object") return original;
      const input = args as Record<string, unknown>;
      if (
        typeof input.batchId !== "string" ||
        !Array.isArray(input.responses)
      ) {
        return original;
      }
      const batch = threadBatchesById.get(input.batchId as ReviewThreadBatchId);
      const turnId =
        typeof input.turnId === "string"
          ? input.turnId
          : batch === undefined
            ? undefined
            : pendingReviewThreadTurn(batch)?.id;
      if (turnId === undefined) return original;
      const responses: ReviewResponseCandidate["responses"] = [];
      for (const response of input.responses) {
        if (response === null || typeof response !== "object") return original;
        const fields = response as Record<string, unknown>;
        const threadId =
          typeof fields.threadId === "string"
            ? fields.threadId
            : fields.commentId;
        if (typeof threadId !== "string" || typeof fields.body !== "string") {
          return original;
        }
        responses.push({ threadId, body: fields.body });
      }
      return { batchId: input.batchId, turnId, responses };
    },
    async execute(_toolCallId, candidate, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const batch = threadBatchesById.get(
        candidate.batchId as ReviewThreadBatchId,
      );
      if (batch === undefined) {
        throw new Error(
          `No pending DiffWalk thread batch matches ${candidate.batchId}. Use the batchId from the pending reviewer turn.`,
        );
      }
      assertThreadBatchCanChange(batch);
      const answered = attachReviewThreadResponses(batch, candidate);
      persistThreadBatch(answered);
      signal?.throwIfAborted();
      const reviewed = await openThreadBatch(ctx, answered);
      const followUp = reviewed.status === "follow-up-submitted";
      return {
        content: [
          {
            type: "text",
            text: followUp
              ? formatReviewThreadFollowUp(reviewed.batch, reviewed.turnId)
              : `Recorded structured DiffWalk responses for turn ${candidate.turnId}. The reviewer inspected the anchored conversations and submitted no follow-up.`,
          },
        ],
        details: reviewed,
        terminate: !followUp,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg(
          "toolTitle",
          `DiffWalk ${args.turnId ?? "responses"} (${args.responses?.length ?? 0})`,
        ),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(
          theme.fg(
            "error",
            content?.type === "text"
              ? content.text
              : "DiffWalk responses were rejected.",
          ),
          0,
          0,
        );
      }
      const outcome = result.details;
      if (outcome === undefined) {
        return new Text(
          theme.fg("success", "DiffWalk responses recorded"),
          0,
          0,
        );
      }
      if (outcome.status === "follow-up-submitted") {
        const turn = requireThreadTurn(outcome.batch, outcome.turnId);
        return new Text(
          theme.fg(
            "warning",
            `${turn.items.length} reviewer follow-up${turn.items.length === 1 ? "" : "s"} sent to the Agent`,
          ),
          0,
          0,
        );
      }
      const resolved = outcome.batch.threads.filter(
        (thread) => thread.resolved,
      ).length;
      return new Text(
        theme.fg(
          "success",
          `${outcome.batch.threads.length} conversations reviewed • ${resolved} resolved`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof ReviewRouteCandidateSchema, GuidedReviewResult>({
    name: GUIDED_REVIEW_TOOL_NAME,
    label: "Guided Review",
    description: GUIDED_REVIEW_TOOL_DESCRIPTION,
    promptSnippet: GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
    parameters: ReviewRouteCandidateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, routeCandidate, signal, _onUpdate, ctx) {
      const pending = pendingReview;
      if (pending === undefined) {
        throw new Error(
          "No DiffWalk snapshot is pending. Ask the user to run /diffwalk first.",
        );
      }
      if (routeCandidate.snapshotId !== pending.review.snapshot.id) {
        throw new Error(
          `Route snapshot ${routeCandidate.snapshotId} does not match pending snapshot ${pending.review.snapshot.id}. Use the frozen snapshot ID from the /diffwalk prompt.`,
        );
      }
      if (pending.inProgress) {
        throw new Error(
          `Guided review for snapshot ${pending.review.snapshot.id} is already open.`,
        );
      }
      if (pending.review.lifecycle !== "preparing-route") {
        throw new Error(
          `Review ${pending.review.id} already has a validated route. Run /diffwalk to resume it.`,
        );
      }

      const route = validateReviewRoute(
        pending.review.snapshot,
        pending.review.delta,
        routeCandidate,
      );
      if (!pending.advisoryNudged) {
        const advisories = assessRouteQuality(
          pending.review.snapshot,
          route,
          detectExactMoves(pending.review.snapshot),
        );
        if (advisories.length > 0) {
          pending.advisoryNudged = true;
          throw new ReviewRouteAdvisoryNudge(advisories);
        }
      }
      const verificationSignal = signal ?? new AbortController().signal;
      try {
        await verifySnapshot(
          pi,
          dependencies.assertReviewSnapshotUnchanged,
          pending.review.snapshot,
          verificationSignal,
        );
      } catch (error: unknown) {
        if (error instanceof ReviewSnapshotDriftError) {
          pendingReview = undefined;
          throw new ReviewSnapshotDriftError(
            `Repository drift invalidated snapshot ${pending.review.snapshot.id}. Run /diffwalk again before opening DiffWalk.`,
          );
        }
        throw error;
      }

      pending.review = attachReviewRoute(pending.review, route, {
        expectedVersion: pending.review.version,
        timestamp: new Date().toISOString(),
      });
      const result = await runPendingReview(ctx, pending);
      return {
        content: [{ type: "text", text: formatGuidedReviewResult(result) }],
        details: result,
        terminate: !shouldSendReviewToAgent(result),
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "DiffWalk review"), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        const message =
          content?.type === "text" ? content.text : "Unknown review error.";
        return new Text(theme.fg("error", message), 0, 0);
      }
      if (result.details === undefined) {
        return new Text("Review finished.", 0, 0);
      }
      return renderGuidedReviewToolResult(result.details, theme);
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verifySnapshot(
  pi: Pick<ExtensionAPI, "exec">,
  assertUnchanged: typeof assertReviewSnapshotUnchanged,
  snapshot: ReviewSnapshot,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await assertUnchanged(createPiGitRunner(pi, signal), snapshot);
  signal.throwIfAborted();
}

function describeDrafts(review: InProgressReview): string {
  const count = review.comments.length;
  return `${count} draft comment${count === 1 ? "" : "s"}`;
}

function describeReviewedUnits(review: InProgressReview): string {
  const count = review.unitProgress.filter(
    (progress) => progress.disposition !== "pending",
  ).length;
  return `${count} reviewed unit${count === 1 ? "" : "s"}`;
}

/** A pending review is replaceable until the human records work inside it. */
function hasReviewProgress(review: InProgressReview): boolean {
  return (
    review.comments.length > 0 ||
    review.unitProgress.some((progress) => progress.disposition !== "pending")
  );
}

function shouldSendReviewToAgent(result: GuidedReviewResult): boolean {
  return result.status === "submitted" && result.comments.length > 0;
}

/**
 * A walkthrough without a needs-review line has nothing to walk, so the command
 * reports the comparison instead of starting a review the agent would have to
 * route as an empty walkthrough. Carried-forward and unreviewable changes are
 * still named here so they cannot disappear silently.
 */
function describeNothingToReview(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  series: ReviewSeries,
  targetRef: string,
): string {
  const parts = [`No line needs review against ${targetRef}.`];
  const carriedForward = delta.lines.filter(
    (requirement) => requirement.type === "carried-forward",
  ).length;
  if (carriedForward > 0) {
    parts.push(
      `${carriedForward} changed line${carriedForward === 1 ? "" : "s"} already reviewed in round ${series.rounds.length}.`,
    );
  }
  let unreviewableCount = 0;
  for (const change of snapshot.changes) {
    const content = change.content;
    if (content.type === "text") continue;
    unreviewableCount += 1;
    const path = change.newPath ?? change.oldPath ?? change.id;
    parts.push(
      `${path} cannot be reviewed line by line: ${content.unsupportedReason}`,
    );
  }
  for (const notice of snapshot.notices) {
    parts.push(notice.message);
  }
  if (carriedForward === 0 && unreviewableCount === 0) {
    parts.push("The worktree matches the comparison.");
  }
  return parts.join(" ");
}

export function buildKickoffMessageDetails(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
): KickoffMessageDetails {
  return {
    targetRef: snapshot.comparison.targetRef,
    changedFileCount: snapshot.changes.length,
    needsReviewLineCount: delta.lines.filter(
      (requirement) => requirement.type === "needs-review",
    ).length,
    carriedForwardLineCount: delta.lines.filter(
      (requirement) => requirement.type === "carried-forward",
    ).length,
    additionalChanges: snapshot.changes
      .filter((change) => change.content.type !== "text")
      .map((change) => ({
        path: displayPath(change),
        description: describeAdditionalChange(change),
      })),
  };
}

export function buildSubmittedReviewMessageDetails(
  result: SubmittedGuidedReviewResult,
): SubmittedReviewMessageDetails {
  return {
    submissionMode: result.submissionMode,
    commentCount: result.comments.length,
  };
}

export const renderKickoffMessage: MessageRenderer<KickoffMessageDetails> = (
  message,
  options,
  theme,
) => {
  const lines = [theme.fg("accent", "DiffWalk")];
  const details = message.details;
  if (details !== undefined) {
    lines.push(
      `Compared with: ${details.targetRef}`,
      `Changed files: ${details.changedFileCount}`,
      `Lines to review: ${details.needsReviewLineCount}`,
    );
    if (details.carriedForwardLineCount > 0) {
      lines.push(
        `Previously reviewed: ${countNoun(details.carriedForwardLineCount, "line")}`,
      );
    }
    const additionalChanges = details.additionalChanges ?? [];
    if (additionalChanges.length > 0) {
      lines.push(
        "Additional changes:",
        ...additionalChanges.map(
          (change) => `  ${change.path}: ${change.description}`,
        ),
      );
    }
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
};

export const renderSubmittedReviewMessage: MessageRenderer<
  SubmittedReviewMessageDetails
> = (message, options, theme) => {
  const details = message.details;
  const lines =
    details === undefined
      ? [theme.fg("accent", "DiffWalk review complete")]
      : submittedReviewDisplayLines(
          details,
          theme.fg("accent", "DiffWalk review complete"),
        );
  return new Text(lines.join("\n"), options.outputPad, 0);
};

export const renderThreadFollowUpMessage: MessageRenderer<
  ThreadFollowUpMessageDetails
> = (message, options, theme) => {
  const details = message.details;
  const lines = [theme.fg("accent", "DiffWalk follow-up")];
  if (details !== undefined) {
    lines.push(
      `${countNoun(details.replyCount, "reply")} sent to the agent.`,
      `Next step: ${submissionNextStep(details.submissionMode)}`,
    );
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
};

function renderGuidedReviewToolResult(
  result: GuidedReviewResult,
  theme: Theme,
): Text {
  const [title = "Review finished", ...body] =
    reviewOutcomeDisplayLines(result);
  const titleColor = result.status === "submitted" ? "success" : "warning";
  return new Text([theme.fg(titleColor, title), ...body].join("\n"), 0, 0);
}

function reviewOutcomeDisplayLines(result: GuidedReviewResult): string[] {
  switch (result.status) {
    case "submitted":
      return submittedReviewDisplayLines(
        buildSubmittedReviewMessageDetails(result),
        "Review complete",
      );
    case "paused":
      return [
        "Review paused",
        "Progress and draft comments remain resumable while the snapshot matches.",
        "Repository changes are allowed; the next /diffwalk discards a stale review and starts over.",
      ];
    case "discarded":
      return ["Review discarded", "Progress and draft comments removed."];
  }
}

function reviewOutcomeNotification(result: GuidedReviewResult): string {
  const [title = "Review finished", ...body] =
    reviewOutcomeDisplayLines(result);
  return [`${title}.`, ...body].join(" ");
}

function submittedReviewDisplayLines(
  details: SubmittedReviewMessageDetails,
  title: string,
): string[] {
  if (details.commentCount === 0) {
    return [title, "No comments submitted.", "No agent follow-up needed."];
  }
  return [
    title,
    `${countNoun(details.commentCount, "comment")} sent to the agent.`,
    `Next step: ${submissionNextStep(details.submissionMode)}`,
  ];
}

function displayPath(change: ReviewSnapshot["changes"][number]): string {
  if (
    change.oldPath !== undefined &&
    change.newPath !== undefined &&
    change.oldPath !== change.newPath
  ) {
    return `${change.oldPath} -> ${change.newPath}`;
  }
  return change.newPath ?? change.oldPath ?? "Unknown file";
}

function describeAdditionalChange(
  change: ReviewSnapshot["changes"][number],
): string {
  if (change.content.type === "binary") return "binary file";
  if (change.oldMode === "160000" || change.newMode === "160000") {
    return "Git submodule changed";
  }
  switch (change.status) {
    case "added":
      return "empty file added";
    case "deleted":
      return "empty file deleted";
    case "renamed":
      return "renamed without text changes";
    case "copied":
      return "copied without text changes";
    case "mode-changed":
      return "file permissions changed";
    case "type-changed":
      return "file type changed";
    case "unmerged":
      return "unresolved merge conflict";
    case "unknown":
      return "unknown Git change";
    case "modified":
      return change.content.type === "metadata-only"
        ? "metadata changed"
        : "text changes could not be read";
  }
}

function submissionNextStep(mode: ReviewSubmissionMode): string {
  switch (mode) {
    case "discuss-first":
      return "Discuss comments before making changes";
    case "apply-change-requests":
      return "Apply requested changes";
  }
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function requireThreadTurn(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
): ReviewThreadBatch["turns"][number] {
  const turn = batch.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new Error(`DiffWalk batch ${batch.id} has no turn ${turnId}.`);
  }
  return turn;
}

export function formatReviewThreadFollowUp(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
): string {
  const turn = requireThreadTurn(batch, turnId);
  return JSON.stringify({
    status: "review-thread-follow-up",
    commentBatchId: batch.id,
    turnId: turn.id,
    submissionMode: turn.submissionMode,
    threads: turn.items.map((item) => {
      const thread = batch.threads.find(
        (candidate) => candidate.id === item.threadId,
      );
      if (thread === undefined) {
        throw new Error(
          `DiffWalk turn ${turn.id} references missing thread ${item.threadId}.`,
        );
      }
      return {
        threadId: thread.id,
        anchor: thread.anchor,
        conversation: reviewThreadConversation(batch, thread.id),
      };
    }),
    instruction:
      turn.submissionMode === "discuss-first"
        ? `Investigate every pending reviewer follow-up without modifying files. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId. The tool reopens the anchored conversations for the reviewer.`
        : `Apply direct change requests and investigate questions or disagreements in every pending reviewer follow-up. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId, explaining any applied change, uncertainty, or disagreement. The tool reopens the anchored conversations for the reviewer.`,
  });
}

export function formatGuidedReviewResult(result: GuidedReviewResult): string {
  if (result.status === "paused") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
      instruction:
        "The review is paused. Follow the user's next request normally, including requests to modify repository files or Git state. Progress and draft comments remain resumable only while the repository matches the frozen snapshot; the next /diffwalk discards a stale review and starts from a fresh snapshot.",
    });
  }
  if (result.status === "discarded") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
      instruction:
        "The user discarded the review without submitting comments. Wait for the user's direction before acting on the change.",
    });
  }
  const turnId = result.commentTurnId ?? ("T1" as ReviewThreadTurnId);
  return JSON.stringify({
    status: result.status,
    snapshotId: result.snapshotId,
    submissionMode: result.submissionMode,
    ...(result.commentBatchId === undefined
      ? {}
      : { commentBatchId: result.commentBatchId, turnId }),
    comments: result.comments.map((comment, index) => ({
      threadId: `C${index + 1}`,
      ...comment,
    })),
    instruction:
      result.comments.length === 0
        ? "No comments require an Agent response."
        : result.submissionMode === "discuss-first"
          ? `Investigate every comment without modifying files. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId. The tool opens the anchored conversations for the reviewer.`
          : `Apply direct change requests and investigate questions or disagreements. Do not answer in ordinary assistant text. Call ${REVIEW_RESPONSES_TOOL_NAME} with this commentBatchId, turnId, and exactly one direct response for every threadId, explaining any applied change, uncertainty, or disagreement. The tool opens the anchored conversations for the reviewer.`,
  });
}
