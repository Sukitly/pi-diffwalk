import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_REVIEW_TARGET,
  DISCARD_OPTION,
  type DiffWalkSession,
  NO_EXCLUDE_OPTION,
  NO_SKIP_OPTION,
  THREADS_OPTION,
} from "./session.ts";

export function parseReviewTarget(args: string): string {
  const target = args.trim();
  return target.length === 0 ? DEFAULT_REVIEW_TARGET : target;
}

/**
 * `/diffwalk` takes a base revision, a standalone option, or the review
 * options `--no-exclude` and `--no-skip` in any order, optionally followed
 * by a base revision.
 *
 * A Git revision cannot start with `-`, so an option can never shadow a base
 * the user meant to review.
 */
export type DiffWalkCommand =
  | {
      readonly type: "review";
      readonly targetRef?: string;
      readonly noExclude?: boolean;
      readonly noSkip?: boolean;
    }
  | { readonly type: "discard" }
  | { readonly type: "threads" };

export function parseDiffWalkCommand(args: string): DiffWalkCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { type: "review" };
  if (trimmed === DISCARD_OPTION) return { type: "discard" };
  if (trimmed === THREADS_OPTION) return { type: "threads" };
  let rest = trimmed;
  let noExclude = false;
  let noSkip = false;
  while (rest.startsWith("-")) {
    const [option = "", ...remainder] = rest.split(/\s+/);
    if (option === NO_EXCLUDE_OPTION) noExclude = true;
    else if (option === NO_SKIP_OPTION) noSkip = true;
    else throw unknownOption(option);
    rest = remainder.join(" ").trim();
  }
  return {
    type: "review",
    ...(rest.length === 0 ? {} : { targetRef: parseReviewTarget(rest) }),
    ...(noExclude ? { noExclude: true } : {}),
    ...(noSkip ? { noSkip: true } : {}),
  };
}

function unknownOption(option: string): Error {
  return new Error(
    `Unknown /diffwalk option ${option}. Use /diffwalk [base] to review a revision, /diffwalk ${NO_EXCLUDE_OPTION} [base] to route every changed line, /diffwalk ${NO_SKIP_OPTION} [base] to walk every unit a judge would skip, /diffwalk ${THREADS_OPTION} to reopen comment threads, or /diffwalk ${DISCARD_OPTION} to drop a pending review.`,
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
            noSkip: command.noSkip === true,
          });
          return;
      }
    },
  });
}
