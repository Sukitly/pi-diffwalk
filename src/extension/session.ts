import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertReviewSnapshotUnchanged,
  captureRepositoryState,
  captureReviewSnapshot,
} from "../git/snapshot.ts";
import { computeReviewDelta } from "../review/delta.ts";
import {
  createInProgressReview,
  discardInProgressReview,
  submitInProgressReview,
} from "../review/in-progress.ts";
import {
  DIFFWALK_SERIES_ENTRY_TYPE,
  parseReviewSeriesEntry,
  serializeReviewSeriesEntry,
} from "../review/persistence.ts";
import { createReviewSeries } from "../review/series.ts";
import {
  DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
  parseReviewThreadBatchEntry,
  serializeReviewThreadBatchEntry,
} from "../review/thread-persistence.ts";
import {
  createReviewThreadBatch,
  isReviewThreadBatchAnswered,
  resolvedCommentLines,
} from "../review/threads.ts";
import type {
  GuidedReviewResult,
  InProgressReview,
  ReviewDelta,
  ReviewSeries,
  ReviewSeriesId,
  ReviewSnapshot,
  ReviewThreadBatch,
  ReviewThreadBatchId,
  SubmittedGuidedReviewResult,
} from "../review/types.ts";
import { openGuidedReview } from "../review-ui/index.ts";
import { openReviewThreads } from "../thread-ui/index.ts";
import type { ReviewThreadUiResult } from "../thread-ui/types.ts";
import { createPiGitRunner } from "./git-runner.ts";
import {
  buildKickoffMessageDetails,
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
} from "./messages.ts";
import { buildReviewKickoffPrompt } from "./prompts.ts";
import { formatReviewThreadFollowUp, requireThreadTurn } from "./results.ts";
import {
  DIFFWALK_RULES_SOURCE,
  type DiffWalkRulesLoadResult,
  type DiffWalkRulesScope,
  type LoadedDiffWalkRules,
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
} from "./rules.ts";

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

export interface PendingReview {
  review: InProgressReview;
  series: ReviewSeries;
  inProgress: boolean;
  /** The selected rules file is captured once so repeated kickoffs stay deterministic. */
  routeRules?: LoadedDiffWalkRules;
  /** Advisory route-quality signals are returned at most once per review. */
  advisoryNudged: boolean;
}

/**
 * Mutable extension state for one pi session: the pending review, completed
 * series restored from session entries, and comment thread batches.
 * Commands and tools mutate it only through these methods.
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

  get pending(): PendingReview | undefined {
    return this.pendingReview;
  }

  clearPending(): void {
    this.pendingReview = undefined;
  }

  threadBatch(id: ReviewThreadBatchId): ReviewThreadBatch | undefined {
    return this.threadBatchesById.get(id);
  }

  latestThreadBatch(): ReviewThreadBatch | undefined {
    return this.latestThreadBatchId === undefined
      ? undefined
      : this.threadBatchesById.get(this.latestThreadBatchId);
  }

  persistThreadBatch(batch: ReviewThreadBatch): void {
    this.threadBatchesById.set(batch.id, batch);
    this.latestThreadBatchId = batch.id;
    this.pi.appendEntry(
      DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
      serializeReviewThreadBatchEntry(batch),
    );
  }

  assertThreadBatchCanChange(batch: ReviewThreadBatch): void {
    const pending = this.pendingReview;
    if (pending?.review.delta.baselineRoundId === batch.roundId) {
      throw new Error(
        `DiffWalk thread batch ${batch.id} is the baseline of pending review ${pending.review.id}. Finish or discard that review before changing thread resolution.`,
      );
    }
  }

  async openThreadBatch(
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

  sendThreadFollowUp(result: ReviewThreadUiResult): void {
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

  sendKickoffPrompt(pending: PendingReview): void {
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

  async verifySnapshot(
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

  async startNewReview(ctx: CommandContext, targetRef: string): Promise<void> {
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

  async runPendingReview(
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

export function describeDrafts(review: InProgressReview): string {
  const count = review.comments.length;
  return `${count} draft comment${count === 1 ? "" : "s"}`;
}

export function describeReviewedUnits(review: InProgressReview): string {
  const count = review.unitProgress.filter(
    (progress) => progress.disposition !== "pending",
  ).length;
  return `${count} reviewed unit${count === 1 ? "" : "s"}`;
}

/** A pending review is replaceable until the human records work inside it. */
export function hasReviewProgress(review: InProgressReview): boolean {
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
