import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertReviewSnapshotUnchanged,
  captureReviewSnapshot,
  type GitRunner,
  ReviewSnapshotDriftError,
} from "./git-diff.ts";
import {
  buildReviewKickoffPrompt,
  GUIDED_REVIEW_TOOL_NAME,
} from "./prompts.ts";
import { computeReviewDelta } from "./review-delta.ts";
import { openGuidedReview } from "./review-ui.ts";
import { validateReviewRoute } from "./route-validation.ts";
import {
  type GuidedReviewResult,
  type ReviewDelta,
  ReviewRouteCandidateSchema,
  type ReviewSnapshot,
} from "./types.ts";

const DEFAULT_REVIEW_TARGET = "HEAD";

interface PendingReview {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
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
  readonly assertReviewSnapshotUnchanged: typeof assertReviewSnapshotUnchanged;
  readonly openGuidedReview: typeof openGuidedReview;
}

const DEFAULT_DEPENDENCIES: DiffWalkDependencies = {
  captureReviewSnapshot,
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

  pi.registerCommand("review", {
    description: "Start a guided review of the current Git changes",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        throw new Error(
          `DiffWalk requires interactive TUI mode; current mode is ${ctx.mode}.`,
        );
      }

      const targetRef = parseReviewTarget(args);
      const snapshot = await dependencies.captureReviewSnapshot(
        createPiGitRunner(pi),
        ctx.cwd,
        targetRef,
      );
      const delta = computeReviewDelta(snapshot);
      pendingReview = { snapshot, delta, inProgress: false };
      pi.sendUserMessage(buildReviewKickoffPrompt(snapshot, delta));
    },
  });

  pi.registerTool<typeof ReviewRouteCandidateSchema, GuidedReviewResult>({
    name: GUIDED_REVIEW_TOOL_NAME,
    label: "Guided Review",
    description:
      "Open the DiffWalk walkthrough for the frozen snapshot prepared by /review. The route must cover every needs-review hunk exactly once.",
    promptSnippet:
      "Open the validated human-guided review route for the pending DiffWalk snapshot",
    parameters: ReviewRouteCandidateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, route, signal, _onUpdate, ctx) {
      const pending = pendingReview;
      if (pending === undefined) {
        throw new Error(
          "No DiffWalk snapshot is pending. Ask the user to run /review first.",
        );
      }
      if (route.snapshotId !== pending.snapshot.id) {
        throw new Error(
          `Route snapshot ${route.snapshotId} does not match pending snapshot ${pending.snapshot.id}. Use the frozen snapshot ID from the /review prompt.`,
        );
      }
      if (pending.inProgress) {
        throw new Error(
          `Guided review for snapshot ${pending.snapshot.id} is already open.`,
        );
      }

      validateReviewRoute(pending.snapshot, pending.delta, route);
      const verificationSignal = signal ?? new AbortController().signal;
      try {
        await verifySnapshot(
          pi,
          dependencies.assertReviewSnapshotUnchanged,
          pending.snapshot,
          verificationSignal,
        );
      } catch (error: unknown) {
        if (error instanceof ReviewSnapshotDriftError) {
          pendingReview = undefined;
          throw new ReviewSnapshotDriftError(
            `Repository drift invalidated snapshot ${pending.snapshot.id}. Run /review again before opening DiffWalk.`,
          );
        }
        throw error;
      }

      pending.inProgress = true;
      try {
        const result = await dependencies.openGuidedReview(ctx, {
          snapshot: pending.snapshot,
          delta: pending.delta,
          route,
          verifySnapshot: (snapshot, verificationSignal) =>
            verifySnapshot(
              pi,
              dependencies.assertReviewSnapshotUnchanged,
              snapshot,
              verificationSignal,
            ),
        });
        pendingReview = undefined;
        return {
          content: [{ type: "text", text: formatGuidedReviewResult(result) }],
          details: result,
        };
      } finally {
        pending.inProgress = false;
      }
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

export function formatGuidedReviewResult(result: GuidedReviewResult): string {
  if (result.status === "cancelled") {
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
