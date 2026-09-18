import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_REVIEW_TARGET,
  DISCARD_OPTION,
  type DiffWalkSession,
  NO_EXCLUDE_OPTION,
  THREADS_OPTION,
} from "./session.ts";

export function parseReviewTarget(args: string): string {
  const target = args.trim();
  return target.length === 0 ? DEFAULT_REVIEW_TARGET : target;
}

/**
 * `/diffwalk` takes a base revision, a standalone option, or `--no-exclude`
 * optionally followed by a base revision.
 *
 * A Git revision cannot start with `-`, so an option can never shadow a base
 * the user meant to review.
 */
export type DiffWalkCommand =
  | {
      readonly type: "review";
      readonly targetRef?: string;
      readonly noExclude?: boolean;
    }
  | { readonly type: "discard" }
  | { readonly type: "threads" };

export function parseDiffWalkCommand(args: string): DiffWalkCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { type: "review" };
  if (trimmed === DISCARD_OPTION) return { type: "discard" };
  if (trimmed === THREADS_OPTION) return { type: "threads" };
  if (trimmed === NO_EXCLUDE_OPTION) return { type: "review", noExclude: true };
  const noExcludePrefix = `${NO_EXCLUDE_OPTION} `;
  if (trimmed.startsWith(noExcludePrefix)) {
    const rest = trimmed.slice(noExcludePrefix.length).trim();
    if (rest.startsWith("-")) throw unknownOption(rest);
    return {
      type: "review",
      targetRef: parseReviewTarget(rest),
      noExclude: true,
    };
  }
  if (trimmed.startsWith("-")) throw unknownOption(trimmed);
  return { type: "review", targetRef: parseReviewTarget(trimmed) };
}

function unknownOption(option: string): Error {
  return new Error(
    `Unknown /diffwalk option ${option}. Use /diffwalk [base] to review a revision, /diffwalk ${NO_EXCLUDE_OPTION} [base] to route every changed line, /diffwalk ${THREADS_OPTION} to reopen comment threads, or /diffwalk ${DISCARD_OPTION} to drop a pending review.`,
  );
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
          await session.reviewCommand(ctx, command.targetRef, {
            noExclude: command.noExclude === true,
          });
          return;
      }
    },
  });
}
