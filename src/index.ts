import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertReviewSnapshotUnchanged,
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
  type ReviewRoute,
  type ReviewRouteCandidate,
  ReviewRouteCandidateSchema,
  type ReviewSeries,
  type ReviewSnapshot,
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

export async function resolveSourceBranch(
  pi: Pick<ExtensionAPI, "exec">,
  repositoryRoot: string,
  snapshot: ReviewSnapshot,
): Promise<string> {
  const result = await pi.exec(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: repositoryRoot },
  );
  if (!result.killed && result.code === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  if (!result.killed && result.code === 1) {
    return `detached:${snapshot.comparison.sourceHeadOid}`;
  }
  const detail = result.stderr.trim();
  throw new Error(
    detail.length > 0
      ? `Unable to identify the review source branch. ${detail}`
      : "Unable to identify the review source branch.",
  );
}

export interface DiffWalkDependencies {
  readonly captureReviewSnapshot: typeof captureReviewSnapshot;
  readonly assertReviewSnapshotUnchanged: typeof assertReviewSnapshotUnchanged;
  readonly openGuidedReview: typeof openGuidedReview;
  readonly resolveSourceBranch: typeof resolveSourceBranch;
}

const DEFAULT_DEPENDENCIES: DiffWalkDependencies = {
  captureReviewSnapshot,
  assertReviewSnapshotUnchanged,
  openGuidedReview,
  resolveSourceBranch,
};

export default function diffWalk(pi: ExtensionAPI): void {
  registerDiffWalk(pi);
}

export function registerDiffWalk(
  pi: ExtensionAPI,
  dependencies: DiffWalkDependencies = DEFAULT_DEPENDENCIES,
): void {
  let pendingReview: PendingReview | undefined;

  async function runPendingReview(
    ctx: Pick<ExtensionContext, "mode" | "ui">,
    pending: PendingReview,
  ): Promise<GuidedReviewResult> {
    const route = pending.review.route;
    if (route === undefined) {
      throw new Error(`Review ${pending.review.id} has no validated route.`);
    }
    pending.inProgress = true;
    try {
      const result = await dependencies.openGuidedReview(ctx, {
        snapshot: pending.review.snapshot,
        delta: pending.review.delta,
        route: routeAsCandidate(route),
        review: pending.review,
        onReviewChange: (review) => {
          pending.review = review;
        },
        verifySnapshot: (snapshot, signal) =>
          verifySnapshot(
            pi,
            dependencies.assertReviewSnapshotUnchanged,
            snapshot,
            signal,
          ),
      });
      if (result.status === "discarded") {
        pendingReview = undefined;
      } else if (result.status === "submitted") {
        const submitted = submitInProgressReview(
          pending.review,
          pending.series,
          pending.review.snapshot.repositoryState,
          {
            expectedVersion: pending.review.version,
            timestamp: new Date().toISOString(),
          },
        );
        pending.review = submitted.review;
        pending.series = submitted.series;
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

      const existing = pendingReview;
      if (existing?.review.lifecycle === "ready") {
        if (existing.inProgress) {
          throw new Error(`Review ${existing.review.id} is already open.`);
        }
        await verifySnapshot(
          pi,
          dependencies.assertReviewSnapshotUnchanged,
          existing.review.snapshot,
          new AbortController().signal,
        );
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
        pi.sendUserMessage(
          buildReviewKickoffPrompt(
            existing.review.snapshot,
            existing.review.delta,
          ),
        );
        return;
      }

      const targetRef = parseReviewTarget(args);
      const snapshot = await dependencies.captureReviewSnapshot(
        createPiGitRunner(pi),
        ctx.cwd,
        targetRef,
      );
      const delta = computeReviewDelta(snapshot);
      const sourceBranch = await dependencies.resolveSourceBranch(
        pi,
        snapshot.repositoryRoot,
        snapshot,
      );
      const series = createReviewSeries({
        repositoryRoot: snapshot.repositoryRoot,
        sourceBranch,
        targetRef,
      });
      const review = createInProgressReview({
        series,
        snapshot,
        delta,
        timestamp: new Date().toISOString(),
      });
      pendingReview = { review, series, inProgress: false };
      pi.sendUserMessage(buildReviewKickoffPrompt(snapshot, delta));
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

function routeAsCandidate(route: ReviewRoute): ReviewRouteCandidate {
  return {
    snapshotId: route.snapshotId,
    units: route.units.map((unit) => ({
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus: [...unit.reviewFocus],
      hunkIds: [...unit.hunkIds],
    })),
    skippedHunks: route.skippedHunks.map((skip) => ({ ...skip })),
  };
}

export function formatGuidedReviewResult(result: GuidedReviewResult): string {
  if (result.status !== "submitted") {
    return JSON.stringify({
      status: result.status,
      snapshotId: result.snapshotId,
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
