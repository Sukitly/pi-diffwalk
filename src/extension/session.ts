import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ReviewSnapshotDriftError } from "../git/errors.ts";
import {
  assertReviewSnapshotUnchanged,
  captureRepositoryState,
  captureReviewSnapshot,
} from "../git/snapshot.ts";
import { computeReviewDelta } from "../review/delta.ts";
import {
  attachReviewRoute,
  createInProgressReview,
  discardInProgressReview,
  submitInProgressReview,
} from "../review/in-progress.ts";
import { detectExactMoves } from "../review/moves.ts";
import {
  DIFFWALK_SERIES_ENTRY_TYPE,
  parseReviewSeriesEntry,
  serializeReviewSeriesEntry,
} from "../review/persistence.ts";
import {
  assessRouteQuality,
  ReviewRouteAdvisoryNudge,
} from "../review/route-advisory.ts";
import { validateReviewRoute } from "../review/route-validation.ts";
import { createReviewSeries } from "../review/series.ts";
import {
  DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
  parseReviewThreadBatchEntry,
  serializeReviewThreadBatchEntry,
} from "../review/thread-persistence.ts";
import {
  attachReviewThreadResponses,
  createReviewThreadBatch,
  isReviewThreadBatchAnswered,
  pendingReviewThreadTurn,
  type ReviewResponseCandidate,
  requireThreadTurn,
  resolvedCommentLines,
} from "../review/threads.ts";
import type {
  GuidedReviewResult,
  InProgressReview,
  ReviewDelta,
  ReviewRouteCandidate,
  ReviewSeries,
  ReviewSeriesId,
  ReviewSnapshot,
  ReviewThreadBatch,
  ReviewThreadBatchId,
  ReviewThreadTurnId,
  SubmittedGuidedReviewResult,
} from "../review/types.ts";
import { openGuidedReview } from "../review-ui/index.ts";
import { openReviewThreads } from "../thread-ui/index.ts";
import type { ReviewThreadUiResult } from "../thread-ui/types.ts";
import { createPiGitRunner } from "./git-runner.ts";
import {
  formatGuidedReviewResult,
  formatReviewThreadFollowUp,
  shouldSendReviewToAgent,
} from "./model-payloads.ts";
import { buildReviewKickoffPrompt } from "./prompts.ts";
import {
  DIFFWALK_RULES_SOURCE,
  type DiffWalkRulesLoadResult,
  type DiffWalkRulesScope,
  type LoadedDiffWalkRules,
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
} from "./rules.ts";
import {
  buildKickoffMessageDetails,
  buildSubmittedReviewMessageDetails,
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
  reviewOutcomeNotification,
} from "./tui-messages.ts";

export const DEFAULT_REVIEW_TARGET = "HEAD";
export const DISCARD_OPTION = "--discard";
export const THREADS_OPTION = "--threads";

export interface DiffWalkDependencies {
  readonly captureReviewSnapshot: typeof captureReviewSnapshot;
  readonly captureRepositoryState: typeof captureRepositoryState;
  readonly assertReviewSnapshotUnchanged: typeof assertReviewSnapshotUnchanged;
  readonly loadGlobalDiffWalkRules: typeof loadGlobalDiffWalkRules;
  readonly loadProjectDiffWalkRules: typeof loadProjectDiffWalkRules;
  readonly openGuidedReview: typeof openGuidedReview;
  readonly openReviewThreads: typeof openReviewThreads;
}

export const DEFAULT_DEPENDENCIES: DiffWalkDependencies = {
  captureReviewSnapshot,
  captureRepositoryState,
  assertReviewSnapshotUnchanged,
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
  openGuidedReview,
  openReviewThreads,
};

export type CommandContext = Pick<
  ExtensionCommandContext,
  "cwd" | "isProjectTrusted" | "ui"
>;

export type ReviewUiContext = Pick<ExtensionContext, "mode" | "ui">;

interface PendingReview {
  review: InProgressReview;
  series: ReviewSeries;
  inProgress: boolean;
  /** The selected rules file is captured once so repeated kickoffs stay deterministic. */
  routeRules?: LoadedDiffWalkRules;
  /** Advisory route-quality signals are returned at most once per review. */
  advisoryNudged: boolean;
}

/**
 * Application service for one pi session. It owns the pending review, the
 * completed series restored from session entries, and the comment thread
 * batches, and every workflow that reads or changes them is a method here:
 * the /diffwalk command and the two tools only parse input and format
 * output. The pending review never leaves this class as a mutable object.
 */
export class DiffWalkSession {
  private readonly pi: ExtensionAPI;
  private readonly dependencies: DiffWalkDependencies;
  private pendingReview: PendingReview | undefined;
  private readonly completedSeriesById = new Map<
    ReviewSeriesId,
    ReviewSeries
  >();
  private readonly threadBatchesById = new Map<
    ReviewThreadBatchId,
    ReviewThreadBatch
  >();
  private latestThreadBatchId: ReviewThreadBatchId | undefined;

  constructor(pi: ExtensionAPI, dependencies: DiffWalkDependencies) {
    this.pi = pi;
    this.dependencies = dependencies;
  }

  restoreFromEntries(
    entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
  ): void {
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.customType === DIFFWALK_SERIES_ENTRY_TYPE) {
        const series = parseReviewSeriesEntry(entry.data);
        if (series !== undefined) {
          this.completedSeriesById.set(series.id, series);
        }
        continue;
      }
      if (entry.customType === DIFFWALK_THREAD_BATCH_ENTRY_TYPE) {
        const batch = parseReviewThreadBatchEntry(entry.data);
        if (batch === undefined) continue;
        this.threadBatchesById.set(batch.id, batch);
        this.latestThreadBatchId = batch.id;
      }
    }
  }

  /** The turn awaiting agent responses in a known batch, for filling a missing turnId. */
  pendingThreadTurnId(batchId: string): ReviewThreadTurnId | undefined {
    const batch = this.threadBatchesById.get(batchId as ReviewThreadBatchId);
    return batch === undefined ? undefined : pendingReviewThreadTurn(batch)?.id;
  }

  /** Reopens the most recent comment threads and reports a follow-up to the agent. */
  async openLatestThreads(
    ctx: CommandContext & ReviewUiContext,
  ): Promise<void> {
    const batch =
      this.latestThreadBatchId === undefined
        ? undefined
        : this.threadBatchesById.get(this.latestThreadBatchId);
    if (batch === undefined) {
      ctx.ui.notify("No DiffWalk comment threads are available.", "info");
      return;
    }
    const result = await this.openThreadBatch(ctx, batch);
    this.sendThreadFollowUp(result);
  }

  /**
   * The submit_diffwalk_responses tool workflow: record the agent's answers
   * on the pending turn, persist them, and reopen the threads for the
   * reviewer.
   */
  async respondToThreads(
    ctx: ReviewUiContext,
    candidate: ReviewResponseCandidate,
    signal: AbortSignal | undefined,
  ): Promise<ReviewThreadUiResult> {
    signal?.throwIfAborted();
    const batch = this.threadBatchesById.get(
      candidate.batchId as ReviewThreadBatchId,
    );
    if (batch === undefined) {
      throw new Error(
        `No pending DiffWalk thread batch matches ${candidate.batchId}. Use the batchId from the pending reviewer turn.`,
      );
    }
    this.assertThreadBatchCanChange(batch);
    const answered = attachReviewThreadResponses(batch, candidate);
    this.persistThreadBatch(answered);
    signal?.throwIfAborted();
    return this.openThreadBatch(ctx, answered);
  }

  private persistThreadBatch(batch: ReviewThreadBatch): void {
    this.threadBatchesById.set(batch.id, batch);
    this.latestThreadBatchId = batch.id;
    this.pi.appendEntry(
      DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
      serializeReviewThreadBatchEntry(batch),
    );
  }

  private assertThreadBatchCanChange(batch: ReviewThreadBatch): void {
    const pending = this.pendingReview;
    if (pending?.review.delta.baselineRoundId === batch.roundId) {
      throw new Error(
        `DiffWalk thread batch ${batch.id} is the baseline of pending review ${pending.review.id}. Finish or discard that review before changing thread resolution.`,
      );
    }
  }

  private async openThreadBatch(
    ctx: ReviewUiContext,
    batch: ReviewThreadBatch,
  ): Promise<ReviewThreadUiResult> {
    this.assertThreadBatchCanChange(batch);
    const result = await this.dependencies.openReviewThreads(ctx, {
      snapshot: this.snapshotForThreadBatch(batch),
      batch,
      onBatchChange: (changed) => this.persistThreadBatch(changed),
    });
    this.threadBatchesById.set(result.batch.id, result.batch);
    this.latestThreadBatchId = result.batch.id;
    return result;
  }

  private sendThreadFollowUp(result: ReviewThreadUiResult): void {
    if (result.status !== "follow-up-submitted") return;
    const turn = requireThreadTurn(result.batch, result.turnId);
    this.pi.sendMessage(
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

  private sendKickoffPrompt(pending: PendingReview): void {
    const { delta, snapshot } = pending.review;
    this.pi.sendMessage(
      {
        customType: DIFFWALK_KICKOFF_MESSAGE_TYPE,
        content: buildReviewKickoffPrompt(snapshot, delta, pending.routeRules),
        display: true,
        details: buildKickoffMessageDetails(snapshot, delta),
      },
      { triggerTurn: true },
    );
  }

  private async verifySnapshot(
    snapshot: ReviewSnapshot,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.dependencies.assertReviewSnapshotUnchanged(
      createPiGitRunner(this.pi, signal),
      snapshot,
    );
    signal.throwIfAborted();
  }

  private async startReview(
    ctx: CommandContext,
    targetRef: string,
  ): Promise<void> {
    const snapshot = await this.dependencies.captureReviewSnapshot(
      createPiGitRunner(this.pi),
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
    const series =
      this.completedSeriesById.get(createdSeries.id) ?? createdSeries;
    const baseline = series.rounds.at(-1);
    const baselineThreads =
      baseline === undefined
        ? undefined
        : [...this.threadBatchesById.values()].find(
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
      this.pendingReview = undefined;
      ctx.ui.notify(
        describeNothingToReview(snapshot, delta, series, targetRef),
        "info",
      );
      return;
    }
    const routeRules = await this.captureRouteRules(ctx, snapshot);
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
    this.pendingReview = pending;
    this.sendKickoffPrompt(pending);
  }

  private async runPendingReview(
    ctx: ReviewUiContext,
    pending: PendingReview,
  ): Promise<GuidedReviewResult> {
    pending.inProgress = true;
    try {
      const result = await this.dependencies.openGuidedReview(ctx, {
        review: pending.review,
        onReviewChange: (review) => {
          pending.review = review;
        },
        onSubmit: (review, signal) =>
          this.submitPendingReview(pending, review, signal),
      });
      if (result.status === "submitted" || result.status === "discarded") {
        this.pendingReview = undefined;
      }
      return result;
    } finally {
      pending.inProgress = false;
    }
  }

  /**
   * The /diffwalk [base] workflow: resume a paused walkthrough, re-send the
   * kickoff for a review still waiting on a route, or capture a new snapshot.
   */
  async reviewCommand(
    ctx: CommandContext & ReviewUiContext,
    requestedTarget: string | undefined,
  ): Promise<void> {
    const existing = this.pendingReview;
    if (existing?.review.lifecycle === "ready") {
      await this.resumeReadyReview(ctx, existing, requestedTarget);
      return;
    }
    if (existing?.review.lifecycle === "preparing-route") {
      await this.resumeRoutePreparation(ctx, existing, requestedTarget);
      return;
    }
    await this.startReview(ctx, requestedTarget ?? DEFAULT_REVIEW_TARGET);
  }

  /**
   * The guided_review tool workflow: validate the route against the pending
   * snapshot, return advisory signals once, confirm the repository still
   * matches, attach the route, and open the walkthrough.
   */
  async attachRouteAndOpen(
    ctx: ReviewUiContext,
    routeCandidate: ReviewRouteCandidate,
    signal: AbortSignal | undefined,
  ): Promise<GuidedReviewResult> {
    const pending = this.pendingReview;
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
    try {
      await this.verifySnapshot(pending.review.snapshot, signal);
    } catch (error: unknown) {
      if (error instanceof ReviewSnapshotDriftError) {
        this.pendingReview = undefined;
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
    return this.runPendingReview(ctx, pending);
  }

  discardPendingReview(ctx: CommandContext): void {
    const existing = this.pendingReview;
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
    this.pendingReview = undefined;
    ctx.ui.notify(
      `Discarded the pending DiffWalk review against ${existing.series.targetRef} and ${describeDrafts(existing.review)}.`,
      "info",
    );
  }

  /** A paused walkthrough resumes unless the user asked for another base or the repository drifted. */
  private async resumeReadyReview(
    ctx: CommandContext & ReviewUiContext,
    existing: PendingReview,
    requestedTarget: string | undefined,
  ): Promise<void> {
    if (existing.inProgress) {
      throw new Error(`Review ${existing.review.id} is already open.`);
    }
    const pendingTarget = existing.series.targetRef;
    if (requestedTarget !== undefined && requestedTarget !== pendingTarget) {
      if (hasReviewProgress(existing.review)) {
        throw new Error(
          `A DiffWalk review against ${pendingTarget} is pending with ${describeDrafts(existing.review)} and ${describeReviewedUnits(existing.review)}. ` +
            `Run /diffwalk without arguments to resume it, or /diffwalk ${DISCARD_OPTION} to drop it before reviewing against ${requestedTarget}.`,
        );
      }
      this.pendingReview = undefined;
      ctx.ui.notify(
        `Replacing the untouched review against ${pendingTarget} with a review against ${requestedTarget}.`,
        "info",
      );
      await this.startReview(ctx, requestedTarget);
      return;
    }
    try {
      await this.verifySnapshot(existing.review.snapshot);
    } catch (error: unknown) {
      if (!(error instanceof ReviewSnapshotDriftError)) throw error;
      this.pendingReview = undefined;
      ctx.ui.notify(
        `The repository changed while the review of snapshot ${existing.review.snapshot.id} was paused. ` +
          `Discarded the stale review and ${describeDrafts(existing.review)}. Starting a new review against ${requestedTarget ?? pendingTarget}.`,
        "warning",
      );
      await this.startReview(ctx, requestedTarget ?? pendingTarget);
      return;
    }
    const result = await this.runPendingReview(ctx, existing);
    if (result.status === "submitted" && shouldSendReviewToAgent(result)) {
      this.pi.sendMessage(
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
  }

  /** A review waiting for a route re-sends the kickoff unless its snapshot is stale. */
  private async resumeRoutePreparation(
    ctx: CommandContext,
    existing: PendingReview,
    requestedTarget: string | undefined,
  ): Promise<void> {
    const pendingTarget = existing.series.targetRef;
    let drifted = false;
    try {
      await this.verifySnapshot(existing.review.snapshot);
    } catch (error: unknown) {
      if (!(error instanceof ReviewSnapshotDriftError)) throw error;
      drifted = true;
    }
    if (
      drifted ||
      (requestedTarget !== undefined && requestedTarget !== pendingTarget)
    ) {
      this.pendingReview = undefined;
      ctx.ui.notify(
        drifted
          ? `The repository changed before a route was prepared for snapshot ${existing.review.snapshot.id}. Capturing a new snapshot.`
          : `Replacing the pending review against ${pendingTarget} with a review against ${requestedTarget}.`,
        "info",
      );
      await this.startReview(ctx, requestedTarget ?? pendingTarget);
      return;
    }
    this.sendKickoffPrompt(existing);
  }

  private async submitPendingReview(
    pending: PendingReview,
    review: InProgressReview,
    signal: AbortSignal,
  ): Promise<SubmittedGuidedReviewResult> {
    signal.throwIfAborted();
    const currentRepositoryState =
      await this.dependencies.captureRepositoryState(
        createPiGitRunner(this.pi, signal),
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
    this.completedSeriesById.set(submitted.series.id, submitted.series);
    this.pi.appendEntry(
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
    if (commentBatch !== undefined) this.persistThreadBatch(commentBatch);
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

  private snapshotForThreadBatch(batch: ReviewThreadBatch): ReviewSnapshot {
    const series = this.completedSeriesById.get(batch.seriesId);
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

  private async captureRouteRules(
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
        this.dependencies.loadProjectDiffWalkRules(
          snapshot.repositoryRoot,
          ctx.isProjectTrusted(),
        ),
      );
      if (projectRules !== undefined) {
        await this.verifySnapshot(snapshot);
        return projectRules;
      }
    }

    return captureRulesSource(ctx, "global", () =>
      this.dependencies.loadGlobalDiffWalkRules(),
    );
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
