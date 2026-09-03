import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_REVIEW_TARGET,
  DISCARD_OPTION,
  type DiffWalkSession,
  THREADS_OPTION,
} from "./session.ts";

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
      switch (command.type) {
        case "discard":
          session.discardPendingReview(ctx);
          return;
        case "threads":
          await session.openLatestThreads(ctx);
          return;
        case "review":
          await session.reviewCommand(ctx, command.targetRef);
          return;
      }
    },
  });
}
