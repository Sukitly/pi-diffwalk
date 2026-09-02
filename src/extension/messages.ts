import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  FileChange,
  GuidedReviewResult,
  ReviewDelta,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewThreadBatch,
  ReviewThreadTurnId,
  SubmittedGuidedReviewResult,
} from "../review/types.ts";
import { countNoun } from "../ui/layout.ts";
import { requireThreadTurn } from "./results.ts";

/**
 * Kickoff and submission payloads reach the LLM verbatim. The TUI renders
 * separate user-facing facts and keeps protocol details out of the transcript.
 */
export const DIFFWALK_KICKOFF_MESSAGE_TYPE = "diffwalk-kickoff";
export const DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE = "diffwalk-review-result";
export const DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE =
  "diffwalk-thread-follow-up";

export interface KickoffAdditionalChangeDetails {
  readonly path: string;
  readonly description: string;
}

/** User-facing facts rendered in the TUI instead of the kickoff prompt. */
export interface KickoffMessageDetails {
  readonly targetRef: string;
  readonly changedFileCount: number;
  readonly needsReviewLineCount: number;
  readonly carriedForwardLineCount: number;
  readonly additionalChanges?: readonly KickoffAdditionalChangeDetails[];
}

/** User-facing facts rendered in the TUI instead of the submission payload. */
export interface SubmittedReviewMessageDetails {
  readonly submissionMode: ReviewSubmissionMode;
  readonly commentCount: number;
}

export interface ThreadFollowUpMessageDetails {
  readonly submissionMode: ReviewSubmissionMode;
  readonly replyCount: number;
}

export function buildKickoffMessageDetails(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
): KickoffMessageDetails {
  return {
    targetRef: snapshot.comparison.targetRef,
    changedFileCount: snapshot.changes.length,
    needsReviewLineCount: delta.lines.filter(
      (requirement) => requirement.type === "needs-review",
    ).length,
    carriedForwardLineCount: delta.lines.filter(
      (requirement) => requirement.type === "carried-forward",
    ).length,
    additionalChanges: snapshot.changes
      .filter((change) => change.content.type !== "text")
      .map((change) => ({
        path: displayPath(change),
        description: describeAdditionalChange(change),
      })),
  };
}

export function buildSubmittedReviewMessageDetails(
  result: SubmittedGuidedReviewResult,
): SubmittedReviewMessageDetails {
  return {
    submissionMode: result.submissionMode,
    commentCount: result.comments.length,
  };
}

export const renderKickoffMessage: MessageRenderer<KickoffMessageDetails> = (
  message,
  options,
  theme,
) => {
  const lines = [theme.fg("accent", "DiffWalk")];
  const details = message.details;
  if (details !== undefined) {
    lines.push(
      `Compared with: ${details.targetRef}`,
      `Changed files: ${details.changedFileCount}`,
      `Lines to review: ${details.needsReviewLineCount}`,
    );
    if (details.carriedForwardLineCount > 0) {
      lines.push(
        `Previously reviewed: ${countNoun(details.carriedForwardLineCount, "line")}`,
      );
    }
    const additionalChanges = details.additionalChanges ?? [];
    if (additionalChanges.length > 0) {
      lines.push(
        "Additional changes:",
        ...additionalChanges.map(
          (change) => `  ${change.path}: ${change.description}`,
        ),
      );
    }
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
};

export const renderSubmittedReviewMessage: MessageRenderer<
  SubmittedReviewMessageDetails
> = (message, options, theme) => {
  const details = message.details;
  const lines =
    details === undefined
      ? [theme.fg("accent", "DiffWalk review complete")]
      : submittedReviewDisplayLines(
          details,
          theme.fg("accent", "DiffWalk review complete"),
        );
  return new Text(lines.join("\n"), options.outputPad, 0);
};

export const renderThreadFollowUpMessage: MessageRenderer<
  ThreadFollowUpMessageDetails
> = (message, options, theme) => {
  const details = message.details;
  const lines = [theme.fg("accent", "DiffWalk follow-up")];
  if (details !== undefined) {
    lines.push(
      `${countNoun(details.replyCount, "reply")} sent to the agent.`,
      `Next step: ${submissionNextStep(details.submissionMode)}`,
    );
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
};

export function renderGuidedReviewToolResult(
  result: GuidedReviewResult,
  theme: Theme,
): Text {
  const [title = "Review finished", ...body] =
    reviewOutcomeDisplayLines(result);
  const titleColor = result.status === "submitted" ? "success" : "warning";
  return new Text([theme.fg(titleColor, title), ...body].join("\n"), 0, 0);
}

export function reviewOutcomeNotification(result: GuidedReviewResult): string {
  const [title = "Review finished", ...body] =
    reviewOutcomeDisplayLines(result);
  return [`${title}.`, ...body].join(" ");
}

export function renderThreadFollowUpToolResult(
  batch: ReviewThreadBatch,
  turnId: ReviewThreadTurnId,
  theme: Theme,
): Text {
  const turn = requireThreadTurn(batch, turnId);
  return new Text(
    theme.fg(
      "warning",
      `${turn.items.length} reviewer follow-up${turn.items.length === 1 ? "" : "s"} sent to the Agent`,
    ),
    0,
    0,
  );
}

function reviewOutcomeDisplayLines(result: GuidedReviewResult): string[] {
  switch (result.status) {
    case "submitted":
      return submittedReviewDisplayLines(
        buildSubmittedReviewMessageDetails(result),
        "Review complete",
      );
    case "paused":
      return [
        "Review paused",
        "Progress and draft comments remain resumable while the snapshot matches.",
        "Repository changes are allowed; the next /diffwalk discards a stale review and starts over.",
      ];
    case "discarded":
      return ["Review discarded", "Progress and draft comments removed."];
  }
}

function submittedReviewDisplayLines(
  details: SubmittedReviewMessageDetails,
  title: string,
): string[] {
  if (details.commentCount === 0) {
    return [title, "No comments submitted.", "No agent follow-up needed."];
  }
  return [
    title,
    `${countNoun(details.commentCount, "comment")} sent to the agent.`,
    `Next step: ${submissionNextStep(details.submissionMode)}`,
  ];
}

function displayPath(change: FileChange): string {
  if (
    change.oldPath !== undefined &&
    change.newPath !== undefined &&
    change.oldPath !== change.newPath
  ) {
    return `${change.oldPath} -> ${change.newPath}`;
  }
  return change.newPath ?? change.oldPath ?? "Unknown file";
}

function describeAdditionalChange(change: FileChange): string {
  if (change.content.type === "binary") return "binary file";
  if (change.oldMode === "160000" || change.newMode === "160000") {
    return "Git submodule changed";
  }
  switch (change.status) {
    case "added":
      return "empty file added";
    case "deleted":
      return "empty file deleted";
    case "renamed":
      return "renamed without text changes";
    case "copied":
      return "copied without text changes";
    case "mode-changed":
      return "file permissions changed";
    case "type-changed":
      return "file type changed";
    case "unmerged":
      return "unresolved merge conflict";
    case "unknown":
      return "unknown Git change";
    case "modified":
      return change.content.type === "metadata-only"
        ? "metadata changed"
        : "text changes could not be read";
  }
}

function submissionNextStep(mode: ReviewSubmissionMode): string {
  switch (mode) {
    case "discuss-first":
      return "Discuss comments before making changes";
    case "apply-change-requests":
      return "Apply requested changes";
  }
}
