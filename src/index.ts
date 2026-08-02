import type {
  ExecResult,
  ExtensionAPI,
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
  submitInProgressReview,
} from "./in-progress-review.ts";
import {
  buildReviewKickoffPrompt,
  GUIDED_REVIEW_TOOL_NAME,
} from "./prompts.ts";
import { computeReviewDelta } from "./review-delta.ts";
import { createReviewSeries } from "./review-series.ts";
import { openGuidedReview } from "./review-ui.ts";
import { validateReviewRoute } from "./route-validation.ts";
import {
  type GuidedReviewResult,
  type InProgressReview,
  ReviewRouteCandidateSchema,
  type ReviewSeries,
  type ReviewSeriesId,
  type ReviewSnapshot,
  type SubmittedGuidedReviewResult,
} from "./types.ts";

const DEFAULT_REVIEW_TARGET = "HEAD";

interface PendingReview {
  review: InProgressReview;
  series: ReviewSeries;
  inProgress: boolean;
}

export function parseReviewTarget(args: string): string {
  const target = args.trim();
  return target.length === 0 ? DEFAULT_REVIEW_TARGET : target;
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

  async function startNewReview(cwd: string, targetRef: string): Promise<void> {
    const snapshot = await dependencies.captureReviewSnapshot(
      createPiGitRunner(pi),
      cwd,
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
    const review = createInProgressReview({
      series,
      snapshot,
      delta,
      timestamp: new Date().toISOString(),
    });
    pendingReview = { review, series, inProgress: false };
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

  pi.registerCommand("diffwalk", {
    description: "Start or resume a guided review of the current Git changes",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        throw new Error(
          `DiffWalk requires interactive TUI mode; current mode is ${ctx.mode}.`,
        );
      }

      const requestedTarget =
        args.trim().length === 0 ? undefined : parseReviewTarget(args);
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
          throw new Error(
            `A DiffWalk review against ${pendingTarget} is pending with ${describeDrafts(existing.review)}. ` +
              `Run /diffwalk without arguments to resume it, or discard it from the walkthrough before reviewing against ${requestedTarget}.`,
          );
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
          await startNewReview(ctx.cwd, requestedTarget ?? pendingTarget);
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
          await startNewReview(ctx.cwd, requestedTarget ?? pendingTarget);
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

      await startNewReview(ctx.cwd, requestedTarget ?? DEFAULT_REVIEW_TARGET);
    },
  });

  pi.registerTool<typeof ReviewRouteCandidateSchema, GuidedReviewResult>({
    name: GUIDED_REVIEW_TOOL_NAME,
    label: "Guided Review",
    description:
      "Open the DiffWalk walkthrough for the frozen snapshot prepared by /diffwalk. The route must cover every needs-review hunk exactly once.",
    promptSnippet:
      "Open the validated human-guided review route for the pending DiffWalk snapshot",
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
