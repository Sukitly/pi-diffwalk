import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ReviewRouteDraftProgress } from "../review/route-draft.ts";
import {
  type ReviewResponseCandidate,
  ReviewResponseCandidateSchema,
} from "../review/threads.ts";
import {
  type GuidedReviewResult,
  ReviewRouteFinishCandidateSchema,
  ReviewRouteUnitCandidateSchema,
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
    typeof ReviewRouteUnitCandidateSchema,
    ReviewRouteDraftProgress
  >({
    name: ADD_UNIT_TOOL_NAME,
    label: "DiffWalk Add Unit",
    description: ADD_UNIT_TOOL_DESCRIPTION,
    promptSnippet: ADD_UNIT_TOOL_PROMPT_SNIPPET,
    parameters: ReviewRouteUnitCandidateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, candidate) {
      const progress = await session.addRouteUnit(candidate);
      return {
        content: [{ type: "text", text: formatRouteUnitProgress(progress) }],
        details: progress,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", `DiffWalk unit: ${args.unit?.title ?? ""}`),
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
  const accepted = `Accepted review unit ${progress.unitCount}.`;
  if (progress.remaining.length === 0) {
    return `${accepted} Every changed line needing review is now covered. Call ${OPEN_TOOL_NAME} to open the walkthrough.`;
  }
  const total = progress.remaining.reduce(
    (sum, file) => sum + file.lineCount,
    0,
  );
  const files = progress.remaining
    .map((file) => `- ${file.path}: ${file.ranges.join(", ")}`)
    .join("\n");
  return `${accepted} ${total} changed line${total === 1 ? "" : "s"} still need routing:\n${files}`;
}

export function registerOpenTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<typeof ReviewRouteFinishCandidateSchema, GuidedReviewResult>({
    name: OPEN_TOOL_NAME,
    label: "DiffWalk Review",
    description: OPEN_TOOL_DESCRIPTION,
    promptSnippet: OPEN_TOOL_PROMPT_SNIPPET,
    parameters: ReviewRouteFinishCandidateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, candidate, signal, _onUpdate, ctx) {
      const result = await session.openRoute(ctx, candidate, signal);
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
  pi.registerTool<typeof ReviewResponseCandidateSchema, ReviewThreadUiResult>({
    name: RESPOND_TOOL_NAME,
    label: "DiffWalk Responses",
    description: RESPOND_TOOL_DESCRIPTION,
    promptSnippet: RESPOND_TOOL_PROMPT_SNIPPET,
    parameters: ReviewResponseCandidateSchema,
    executionMode: "sequential",
    prepareArguments(args): ReviewResponseCandidate {
      return normalizeResponseArguments(args, session);
    },
    async execute(_toolCallId, candidate, signal, _onUpdate, ctx) {
      const reviewed = await session.respondToThreads(ctx, candidate, signal);
      const followUp = reviewed.status === "follow-up-submitted";
      return {
        content: [
          {
            type: "text",
            text: followUp
              ? formatReviewThreadFollowUp(reviewed.batch, reviewed.turnId)
              : `Recorded structured DiffWalk responses for turn ${candidate.turnId}. The reviewer inspected the anchored conversations and submitted no follow-up.`,
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
          `DiffWalk ${args.turnId ?? "responses"} (${args.responses?.length ?? 0})`,
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
 * Models sometimes send the older field names or omit the turn. The batch's
 * pending turn fills a missing turnId and commentId is accepted for threadId;
 * anything else is returned unchanged so schema validation reports it.
 */
function normalizeResponseArguments(
  args: unknown,
  session: DiffWalkSession,
): ReviewResponseCandidate {
  const original = args as ReviewResponseCandidate;
  if (args === null || typeof args !== "object") return original;
  const input = args as Record<string, unknown>;
  if (typeof input.batchId !== "string" || !Array.isArray(input.responses)) {
    return original;
  }
  const turnId =
    typeof input.turnId === "string"
      ? input.turnId
      : session.pendingThreadTurnId(input.batchId);
  if (turnId === undefined) return original;
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
  return { batchId: input.batchId, turnId, responses };
}
