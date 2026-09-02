import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReviewSnapshotDriftError } from "../git/errors.ts";
import {
  buildSubmittedReviewMessageDetails,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
  reviewOutcomeNotification,
} from "./messages.ts";
import {
  formatGuidedReviewResult,
  shouldSendReviewToAgent,
} from "./results.ts";
import {
  type CommandContext,
  type DiffWalkSession,
  describeDrafts,
  describeReviewedUnits,
  hasReviewProgress,
  type PendingReview,
  type ReviewUiContext,
} from "./session.ts";

const DEFAULT_REVIEW_TARGET = "HEAD";
const DISCARD_OPTION = "--discard";
const THREADS_OPTION = "--threads";

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

export function registerDiffWalkCommand(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
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
        session.discardPendingReview(ctx);
        return;
      }
      if (command.type === "threads") {
        const batch = session.latestThreadBatch();
        if (batch === undefined) {
          ctx.ui.notify("No DiffWalk comment threads are available.", "info");
          return;
        }
        const result = await session.openThreadBatch(ctx, batch);
        session.sendThreadFollowUp(result);
        return;
      }

      const requestedTarget = command.targetRef;
      const existing = session.pending;
      if (existing?.review.lifecycle === "ready") {
        await resumeReadyReview(pi, session, ctx, existing, requestedTarget);
        return;
      }
      if (existing?.review.lifecycle === "preparing-route") {
        await resumeRoutePreparation(session, ctx, existing, requestedTarget);
        return;
      }

      await session.startNewReview(
        ctx,
        requestedTarget ?? DEFAULT_REVIEW_TARGET,
      );
    },
  });
}

/** A paused walkthrough resumes unless the user asked for another base or the repository drifted. */
async function resumeReadyReview(
  pi: ExtensionAPI,
  session: DiffWalkSession,
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
    session.clearPending();
    ctx.ui.notify(
      `Replacing the untouched review against ${pendingTarget} with a review against ${requestedTarget}.`,
      "info",
    );
    await session.startNewReview(ctx, requestedTarget);
    return;
  }
  try {
    await session.verifySnapshot(existing.review.snapshot);
  } catch (error: unknown) {
    if (!(error instanceof ReviewSnapshotDriftError)) throw error;
    session.clearPending();
    ctx.ui.notify(
      `The repository changed while the review of snapshot ${existing.review.snapshot.id} was paused. ` +
        `Discarded the stale review and ${describeDrafts(existing.review)}. Starting a new review against ${requestedTarget ?? pendingTarget}.`,
      "warning",
    );
    await session.startNewReview(ctx, requestedTarget ?? pendingTarget);
    return;
  }
  const result = await session.runPendingReview(ctx, existing);
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
}

/** A review waiting for a route re-sends the kickoff unless its snapshot is stale. */
async function resumeRoutePreparation(
  session: DiffWalkSession,
  ctx: CommandContext,
  existing: PendingReview,
  requestedTarget: string | undefined,
): Promise<void> {
  const pendingTarget = existing.series.targetRef;
  let drifted = false;
  try {
    await session.verifySnapshot(existing.review.snapshot);
  } catch (error: unknown) {
    if (!(error instanceof ReviewSnapshotDriftError)) throw error;
    drifted = true;
  }
  if (
    drifted ||
    (requestedTarget !== undefined && requestedTarget !== pendingTarget)
  ) {
    session.clearPending();
    ctx.ui.notify(
      drifted
        ? `The repository changed before a route was prepared for snapshot ${existing.review.snapshot.id}. Capturing a new snapshot.`
        : `Replacing the pending review against ${pendingTarget} with a review against ${requestedTarget}.`,
      "info",
    );
    await session.startNewReview(ctx, requestedTarget ?? pendingTarget);
    return;
  }
  session.sendKickoffPrompt(existing);
}
