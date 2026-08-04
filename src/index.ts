import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertReviewSnapshotUnchanged,
  captureRepositoryState,
  captureReviewSnapshot,
  type GitRunner,
  ReviewSnapshotDriftError,
} from "./git-diff.ts";
import {
  attachReviewRoute,
  createInProgressReview,
  discardInProgressReview,
  submitInProgressReview,
} from "./in-progress-review.ts";
import {
  buildReviewKickoffPrompt,
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
  GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
} from "./prompts.ts";
import { computeReviewDelta } from "./review-delta.ts";
import { detectExactMoves } from "./review-moves.ts";
import { createReviewSeries } from "./review-series.ts";
import { openGuidedReview } from "./review-ui.ts";
import {
  assessRouteQuality,
  ReviewRouteAdvisoryNudge,
} from "./route-advisory.ts";
import { validateReviewRoute } from "./route-validation.ts";
import {
  type GuidedReviewResult,
  type InProgressReview,
  type ReviewDelta,
  ReviewRouteCandidateSchema,
  type ReviewSeries,
  type ReviewSeriesId,
  type ReviewSnapshot,
  type SubmittedGuidedReviewResult,
} from "./types.ts";

const DEFAULT_REVIEW_TARGET = "HEAD";
const DISCARD_OPTION = "--discard";

type CommandContext = Pick<ExtensionCommandContext, "cwd" | "ui">;

interface PendingReview {
  review: InProgressReview;
  series: ReviewSeries;
  inProgress: boolean;
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
  | { readonly type: "discard" };

export function parseDiffWalkCommand(args: string): DiffWalkCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { type: "review" };
  if (trimmed === DISCARD_OPTION) return { type: "discard" };
  if (trimmed.startsWith("-")) {
    throw new Error(
      `Unknown /diffwalk option ${trimmed}. Use /diffwalk [base] to review a revision, or /diffwalk ${DISCARD_OPTION} to drop a pending review.`,
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
  readonly openGuidedReview: typeof openGuidedReview;
}

const DEFAULT_DEPENDENCIES: DiffWalkDependencies = {
  captureReviewSnapshot,
  captureRepositoryState,
  assertReviewSnapshotUnchanged,
  openGuidedReview,
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
    const delta = computeReviewDelta(snapshot, series.rounds.at(-1));
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
    const review = createInProgressReview({
      series,
      snapshot,
      delta,
      timestamp: new Date().toISOString(),
    });
    pendingReview = {
      review,
      series,
      inProgress: false,
      advisoryNudged: false,
    };
    pi.sendUserMessage(buildReviewKickoffPrompt(snapshot, delta));
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
    return {
      status: "submitted",
      snapshotId: review.snapshot.id,
      submissionMode: review.submissionMode,
      comments: review.comments,
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
        if (result.status === "submitted") {
          pi.sendUserMessage(formatGuidedReviewResult(result));
        } else if (result.status === "discarded") {
          ctx.ui.notify(
            "Discarded the DiffWalk review and its drafts.",
            "info",
          );
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
        pi.sendUserMessage(
          buildReviewKickoffPrompt(
            existing.review.snapshot,
            existing.review.delta,
          ),
        );
        return;
      }

      await startNewReview(ctx, requestedTarget ?? DEFAULT_REVIEW_TARGET);
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
      };
    },
  });
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

export function formatGuidedReviewResult(result: GuidedReviewResult): string {
  if (result.status === "paused") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
      instruction:
        "The review is paused and its frozen snapshot is still pending. Do not modify repository files or Git state until the user resumes with /diffwalk and submits or discards the review.",
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
  return JSON.stringify({
    status: result.status,
    snapshotId: result.snapshotId,
    submissionMode: result.submissionMode,
    comments: result.comments,
    instruction:
      result.submissionMode === "discuss-first"
        ? "Investigate and respond to every comment without modifying files."
        : "Apply direct change requests; explain questions, uncertainty, or disagreement before making unrelated changes.",
  });
}
