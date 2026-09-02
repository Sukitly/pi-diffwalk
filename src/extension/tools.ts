import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ReviewSnapshotDriftError } from "../git/errors.ts";
import { attachReviewRoute } from "../review/in-progress.ts";
import { detectExactMoves } from "../review/moves.ts";
import {
  assessRouteQuality,
  ReviewRouteAdvisoryNudge,
} from "../review/route-advisory.ts";
import { validateReviewRoute } from "../review/route-validation.ts";
import {
  attachReviewThreadResponses,
  pendingReviewThreadTurn,
  REVIEW_RESPONSES_TOOL_DESCRIPTION,
  REVIEW_RESPONSES_TOOL_NAME,
  REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET,
  type ReviewResponseCandidate,
  ReviewResponseCandidateSchema,
} from "../review/threads.ts";
import {
  type GuidedReviewResult,
  ReviewRouteCandidateSchema,
  type ReviewThreadBatchId,
} from "../review/types.ts";
import type { ReviewThreadUiResult } from "../thread-ui/types.ts";
import {
  renderGuidedReviewToolResult,
  renderThreadFollowUpToolResult,
} from "./messages.ts";
import {
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
  GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
} from "./prompts.ts";
import {
  formatGuidedReviewResult,
  formatReviewThreadFollowUp,
  shouldSendReviewToAgent,
} from "./results.ts";
import type { DiffWalkSession } from "./session.ts";

export function registerGuidedReviewTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<typeof ReviewRouteCandidateSchema, GuidedReviewResult>({
    name: GUIDED_REVIEW_TOOL_NAME,
    label: "Guided Review",
    description: GUIDED_REVIEW_TOOL_DESCRIPTION,
    promptSnippet: GUIDED_REVIEW_TOOL_PROMPT_SNIPPET,
    parameters: ReviewRouteCandidateSchema,
    executionMode: "sequential",
    async execute(_toolCallId, routeCandidate, signal, _onUpdate, ctx) {
      const pending = session.pending;
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
      try {
        await session.verifySnapshot(pending.review.snapshot, signal);
      } catch (error: unknown) {
        if (error instanceof ReviewSnapshotDriftError) {
          session.clearPending();
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
      const result = await session.runPendingReview(ctx, pending);
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

export function registerReviewResponsesTool(
  pi: ExtensionAPI,
  session: DiffWalkSession,
): void {
  pi.registerTool<typeof ReviewResponseCandidateSchema, ReviewThreadUiResult>({
    name: REVIEW_RESPONSES_TOOL_NAME,
    label: "DiffWalk Responses",
    description: REVIEW_RESPONSES_TOOL_DESCRIPTION,
    promptSnippet: REVIEW_RESPONSES_TOOL_PROMPT_SNIPPET,
    parameters: ReviewResponseCandidateSchema,
    executionMode: "sequential",
    prepareArguments(args): ReviewResponseCandidate {
      return normalizeResponseArguments(args, session);
    },
    async execute(_toolCallId, candidate, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const batch = session.threadBatch(
        candidate.batchId as ReviewThreadBatchId,
      );
      if (batch === undefined) {
        throw new Error(
          `No pending DiffWalk thread batch matches ${candidate.batchId}. Use the batchId from the pending reviewer turn.`,
        );
      }
      session.assertThreadBatchCanChange(batch);
      const answered = attachReviewThreadResponses(batch, candidate);
      session.persistThreadBatch(answered);
      signal?.throwIfAborted();
      const reviewed = await session.openThreadBatch(ctx, answered);
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
  const batch = session.threadBatch(input.batchId as ReviewThreadBatchId);
  const turnId =
    typeof input.turnId === "string"
      ? input.turnId
      : batch === undefined
        ? undefined
        : pendingReviewThreadTurn(batch)?.id;
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
