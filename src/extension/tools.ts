import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  ReviewRouteDraftProgress,
  ReviewRouteSkipProgress,
} from "../review/route-draft.ts";
import type { ReviewResponseCandidate } from "../review/threads.ts";
import {
  type GuidedReviewResult,
  ReviewOpenToolSchema,
  ReviewSkipCandidateToolSchema,
  ReviewUnitCandidateToolSchema,
} from "../review/types.ts";
import type { ReviewThreadUiResult } from "../thread-ui/types.ts";
import {
  formatGuidedReviewResult,
  formatReviewThreadFollowUp,
  shouldSendReviewToAgent,
} from "./model-payloads.ts";
import {
  ADD_UNIT_TOOL_DESCRIPTION,
  ADD_UNIT_TOOL_NAME,
  ADD_UNIT_TOOL_PROMPT_SNIPPET,
  OPEN_TOOL_DESCRIPTION,
  OPEN_TOOL_NAME,
  OPEN_TOOL_PROMPT_SNIPPET,
  RESPOND_TOOL_DESCRIPTION,
  RESPOND_TOOL_NAME,
  RESPOND_TOOL_PROMPT_SNIPPET,
  SKIP_TOOL_DESCRIPTION,
  SKIP_TOOL_NAME,
  SKIP_TOOL_PROMPT_SNIPPET,
} from "./prompts.ts";
import type { DiffWalkSession } from "./session.ts";
import {
  renderAddUnitToolResult,
  renderGuidedReviewToolResult,
  renderThreadFollowUpToolResult,
} from "./tui-messages.ts";

export function registerAddUnitTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<
    typeof ReviewUnitCandidateToolSchema,
    ReviewRouteDraftProgress
  >({
    name: ADD_UNIT_TOOL_NAME,
    label: "DiffWalk Add Unit",
    description: ADD_UNIT_TOOL_DESCRIPTION,
    promptSnippet: ADD_UNIT_TOOL_PROMPT_SNIPPET,
    parameters: ReviewUnitCandidateToolSchema,
    executionMode: "sequential",
    async execute(_toolCallId, unit, _signal, _onUpdate, ctx) {
      const progress = await session.addRouteUnit(ctx, unit);
      return {
        content: [{ type: "text", text: formatRouteUnitProgress(progress) }],
        details: progress,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `DiffWalk unit: ${args.title ?? ""}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(
          theme.fg(
            "error",
            content?.type === "text" ? content.text : "Review unit rejected.",
          ),
          0,
          0,
        );
      }
      return result.details === undefined
        ? new Text("Review unit accepted.", 0, 0)
        : renderAddUnitToolResult(result.details, theme);
    },
  });
}

/** The remaining work is the only thing the agent needs back from an append. */
function formatRouteUnitProgress(progress: ReviewRouteDraftProgress): string {
  return formatRemaining(
    `Accepted review unit ${progress.unitCount}${describeVerdict(progress.acceptedUnit)}.`,
    progress.remaining,
  );
}

/** One clause so the agent and the transcript show what the judge did. */
function describeVerdict(
  unit: ReviewRouteDraftProgress["acceptedUnit"],
): string {
  if (unit.fold !== undefined) {
    return unit.fold.source === "agent"
      ? " (folded on the routine claim)"
      : ` (folded: ${unit.fold.reasons.join(" ")})`;
  }
  if (unit.walked !== undefined) {
    return ` (walked: ${unit.walked.blockers.join("; ")})`;
  }
  return "";
}

function formatRouteSkipProgress(progress: ReviewRouteSkipProgress): string {
  const noun = progress.skippedLineCount === 1 ? "line" : "lines";
  return formatRemaining(
    `Skipped ${progress.skippedLineCount} changed ${noun} in ${progress.acceptedSkip.span.path}.`,
    progress.remaining,
  );
}

function formatRemaining(
  accepted: string,
  remaining: ReviewRouteDraftProgress["remaining"],
): string {
  if (remaining.length === 0) {
    return `${accepted} Every changed line needing review is now covered. Call ${OPEN_TOOL_NAME} to open the walkthrough.`;
  }
  const total = remaining.reduce((sum, file) => sum + file.lineCount, 0);
  const files = remaining
    .map((file) => `- ${file.path}: ${file.ranges.join(", ")}`)
    .join("\n");
  return `${accepted} ${total} changed line${total === 1 ? "" : "s"} still need routing:\n${files}`;
}

export function registerSkipTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<
    typeof ReviewSkipCandidateToolSchema,
    ReviewRouteSkipProgress
  >({
    name: SKIP_TOOL_NAME,
    label: "DiffWalk Skip",
    description: SKIP_TOOL_DESCRIPTION,
    promptSnippet: SKIP_TOOL_PROMPT_SNIPPET,
    parameters: ReviewSkipCandidateToolSchema,
    executionMode: "sequential",
    async execute(_toolCallId, skip) {
      const progress = session.skipRouteRegion(skip);
      return {
        content: [{ type: "text", text: formatRouteSkipProgress(progress) }],
        details: progress,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `DiffWalk skip: ${args.span?.path ?? ""}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(
          theme.fg(
            "error",
            content?.type === "text" ? content.text : "Skip rejected.",
          ),
          0,
          0,
        );
      }
      const details = result.details;
      if (details === undefined) return new Text("Skip accepted.", 0, 0);
      const remaining = details.remaining.reduce(
        (sum, file) => sum + file.lineCount,
        0,
      );
      return new Text(
        theme.fg(
          "muted",
          `Skipped ${details.skippedLineCount} in ${details.acceptedSkip.span.path} • ${remaining} left to route`,
        ),
        0,
        0,
      );
    },
  });
}

export function registerOpenTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<typeof ReviewOpenToolSchema, GuidedReviewResult>({
    name: OPEN_TOOL_NAME,
    label: "DiffWalk Review",
    description: OPEN_TOOL_DESCRIPTION,
    promptSnippet: OPEN_TOOL_PROMPT_SNIPPET,
    parameters: ReviewOpenToolSchema,
    executionMode: "sequential",
    async execute(_toolCallId, _args, signal, _onUpdate, ctx) {
      const result = await session.openRoute(ctx, signal);
      return {
        content: [{ type: "text", text: formatGuidedReviewResult(result) }],
        details: result,
        terminate: !shouldSendReviewToAgent(result),
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "DiffWalk review"), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        const message =
          content?.type === "text" ? content.text : "Unknown review error.";
        return new Text(theme.fg("error", message), 0, 0);
      }
      if (result.details === undefined) {
        return new Text("Review finished.", 0, 0);
      }
      return renderGuidedReviewToolResult(result.details, theme);
    },
  });
}

export function registerRespondTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<typeof ReviewRespondToolSchema, ReviewThreadUiResult>({
    name: RESPOND_TOOL_NAME,
    label: "DiffWalk Responses",
    description: RESPOND_TOOL_DESCRIPTION,
    promptSnippet: RESPOND_TOOL_PROMPT_SNIPPET,
    parameters: ReviewRespondToolSchema,
    executionMode: "sequential",
    prepareArguments(args): ReviewRespondArguments {
      return normalizeResponseArguments(args);
    },
    async execute(_toolCallId, candidate, signal, _onUpdate, ctx) {
      const reviewed = await session.respondToThreads(
        ctx,
        candidate.responses,
        signal,
      );
      const followUp = reviewed.status === "follow-up-submitted";
      return {
        content: [
          {
            type: "text",
            text: followUp
              ? formatReviewThreadFollowUp(reviewed.batch, reviewed.turnId)
              : "Recorded structured DiffWalk responses. The reviewer inspected the anchored conversations and submitted no follow-up.",
          },
        ],
        details: reviewed,
        terminate: !followUp,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg(
          "toolTitle",
          `DiffWalk responses (${args.responses?.length ?? 0})`,
        ),
        0,
        0,
      );
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(
          theme.fg(
            "error",
            content?.type === "text"
              ? content.text
              : "DiffWalk responses were rejected.",
          ),
          0,
          0,
        );
      }
      const outcome = result.details;
      if (outcome === undefined) {
        return new Text(
          theme.fg("success", "DiffWalk responses recorded"),
          0,
          0,
        );
      }
      if (outcome.status === "follow-up-submitted") {
        return renderThreadFollowUpToolResult(
          outcome.batch,
          outcome.turnId,
          theme,
        );
      }
      const resolved = outcome.batch.threads.filter(
        (thread) => thread.resolved,
      ).length;
      return new Text(
        theme.fg(
          "success",
          `${outcome.batch.threads.length} conversations reviewed • ${resolved} resolved`,
        ),
        0,
        0,
      );
    },
  });
}

/**
 * The pending turn is the only one that can be answered, so the tool takes
 * responses alone. Identifiers a model may still send from older prompts are
 * dropped, and commentId is accepted for threadId; anything else is returned
 * unchanged so schema validation reports it.
 */
export const ReviewRespondToolSchema = Type.Object(
  {
    responses: Type.Array(
      Type.Object(
        {
          threadId: Type.String({
            description: "Thread identifier from the pending turn, such as C1",
          }),
          body: Type.String({
            description:
              "Direct response to the latest reviewer message: answer first, then give evidence or applied changes, and end with any uncertainty",
          }),
        },
        { additionalProperties: false },
      ),
      {
        description: "Exactly one response for every thread in the turn",
        minItems: 1,
      },
    ),
  },
  { additionalProperties: false },
);

export type ReviewRespondArguments = Type.Static<
  typeof ReviewRespondToolSchema
>;

function normalizeResponseArguments(args: unknown): ReviewRespondArguments {
  const original = args as ReviewRespondArguments;
  if (args === null || typeof args !== "object") return original;
  const input = args as Record<string, unknown>;
  if (!Array.isArray(input.responses)) return original;
  const responses: ReviewResponseCandidate["responses"] = [];
  for (const response of input.responses) {
    if (response === null || typeof response !== "object") return original;
    const fields = response as Record<string, unknown>;
    const threadId =
      typeof fields.threadId === "string" ? fields.threadId : fields.commentId;
    if (typeof threadId !== "string" || typeof fields.body !== "string") {
      return original;
    }
    responses.push({ threadId, body: fields.body });
  }
  return { responses };
}
