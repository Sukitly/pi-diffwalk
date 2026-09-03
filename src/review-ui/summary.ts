import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ResolvedSpan,
  ReviewComment,
  ReviewRoute,
  ReviewRouteSkip,
  ReviewSubmissionMode,
  ReviewUnit,
} from "../review/types.ts";
import { displayPath } from "../ui/paths.ts";
import { safeText, wrapStyled, wrapWithPrefix } from "../ui/text.ts";
import type {
  InventoryEntry,
  ReviewUiTheme,
  SubmissionFailure,
  SubmissionStatus,
  TransientFeedback,
} from "./types.ts";
import { renderTransientFeedback } from "./walkthrough.ts";

/**
 * Skipped regions grouped by reason, then by file, so a reason that covers
 * many regions reads once with a compact list instead of once per region.
 */
function renderSkippedRegionGroups(
  skips: readonly ReviewRouteSkip[],
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const byReason = new Map<string, Map<string, string[]>>();
  for (const skip of skips) {
    const files = byReason.get(skip.reason) ?? new Map<string, string[]>();
    const ranges = files.get(skip.span.path) ?? [];
    ranges.push(describeSkippedRange(skip.span));
    files.set(skip.span.path, ranges);
    byReason.set(skip.reason, files);
  }
  const lines: string[] = [];
  for (const [reason, files] of byReason) {
    lines.push(...wrapStyled(theme.fg("text", safeText(reason)), width));
    for (const [path, ranges] of files) {
      lines.push(
        ...wrapWithPrefix(
          "  ",
          `${theme.fg("muted", safeText(path))} ${theme.fg("dim", ranges.join(", "))}`,
          width,
        ),
      );
    }
  }
  return lines;
}

/** New-side range when the region has one; removed-only regions say so. */
function describeSkippedRange(span: ResolvedSpan): string {
  if (span.newStart !== undefined && span.newEnd !== undefined) {
    return span.newStart === span.newEnd
      ? String(span.newStart)
      : `${span.newStart}-${span.newEnd}`;
  }
  if (span.oldStart !== undefined && span.oldEnd !== undefined) {
    return span.oldStart === span.oldEnd
      ? `old ${span.oldStart}`
      : `old ${span.oldStart}-${span.oldEnd}`;
  }
  return "";
}

export function renderSubmissionNotice(
  status: SubmissionStatus,
  failure: SubmissionFailure | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (status === "checking") {
    return wrapStyled(
      theme.fg("muted", "Checking the frozen snapshot before submission..."),
      width,
    );
  }
  if (failure === undefined) return [];
  const title =
    failure.type === "repository-drifted"
      ? "Repository drift blocks submission"
      : "Snapshot verification failed";
  return [
    ...wrapStyled(theme.fg("error", theme.bold(title)), width),
    ...wrapStyled(
      theme.fg("warning", safeText(errorMessage(failure.error))),
      width,
    ),
  ];
}

export function renderSummaryLines(
  comments: readonly ReviewComment[],
  route: ReviewRoute,
  inventory: readonly InventoryEntry[],
  submissionMode: ReviewSubmissionMode,
  feedback: TransientFeedback | undefined,
  pendingUnits: readonly ReviewUnit[],
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines: string[] = [];
  lines.push(...renderTransientFeedback(feedback, theme, width));
  if (pendingUnits.length > 0) {
    lines.unshift(theme.fg("warning", theme.bold("Review incomplete")));
    lines.push(
      ...wrapStyled(
        theme.fg(
          "warning",
          `${pendingUnits.length} section${pendingUnits.length === 1 ? "" : "s"} remain: ${safeText(pendingUnits.map((unit) => unit.title).join(", "))}.`,
        ),
        width,
      ),
      "",
      theme.fg(
        "text",
        "Press Enter to continue with the next pending section.",
      ),
    );
    return lines;
  }
  lines.unshift(
    theme.fg("accent", theme.bold("Comment batch and submission mode")),
  );
  lines.push(
    modeLine(
      submissionMode === "discuss-first",
      "Discuss first",
      "Agent investigates and responds without editing files.",
      theme,
      width,
    ),
    modeLine(
      submissionMode === "apply-change-requests",
      "Apply change requests",
      "Agent may apply direct requests; questions still require discussion.",
      theme,
      width,
    ),
    "",
    theme.fg(
      "muted",
      theme.bold(`Comments (${comments.length}) returned as one batch`),
    ),
  );

  if (comments.length === 0) {
    lines.push(theme.fg("dim", "No comments were added."));
  }
  for (const [index, comment] of comments.entries()) {
    lines.push(
      ...wrapStyled(
        theme.fg(
          "accent",
          `${index + 1}. ${displayCommentPath(comment)} ${renderCommentAnchor(comment)}`,
        ),
        width,
      ),
    );
    lines.push(
      ...wrapWithPrefix(
        "   ",
        theme.fg("toolDiffContext", safeText(comment.selectedText)),
        width,
      ),
    );
    lines.push(
      ...wrapWithPrefix("   ", theme.fg("text", safeText(comment.body)), width),
    );
  }

  lines.push("", theme.fg("muted", theme.bold("Explicitly skipped regions")));
  if (route.skippedSpans.length === 0) {
    lines.push(theme.fg("dim", "None."));
  } else {
    lines.push(...renderSkippedRegionGroups(route.skippedSpans, theme, width));
  }

  const nonTextChanges = inventory.filter((entry) => entry.type !== "file");
  lines.push("", theme.fg("muted", theme.bold("Non-text changes and notices")));
  if (nonTextChanges.length === 0) {
    lines.push(theme.fg("dim", "None."));
  } else {
    for (const entry of nonTextChanges) {
      lines.push(
        ...wrapStyled(
          theme.fg(
            "warning",
            `${safeText(entry.title)}: ${safeText(entry.detail)}`,
          ),
          width,
        ),
      );
    }
  }

  return lines;
}

function modeLine(
  selected: boolean,
  title: string,
  description: string,
  theme: ReviewUiTheme,
  width: number,
): string {
  const text = `${selected ? ">" : " "} ${title}: ${description}`;
  const fitted = truncateToWidth(safeText(text), width, "", true);
  return selected
    ? theme.bg("selectedBg", theme.fg("text", fitted))
    : theme.fg("dim", fitted);
}

function displayCommentPath(comment: ReviewComment): string {
  if (
    comment.oldPath !== undefined &&
    comment.newPath !== undefined &&
    comment.oldPath !== comment.newPath
  ) {
    return `${displayPath(comment.oldPath)} -> ${displayPath(comment.newPath)}`;
  }
  return displayPath(comment.filePath);
}

function renderCommentAnchor(comment: ReviewComment): string {
  return `(old ${comment.oldLine ?? "-"}, new ${comment.newLine ?? "-"})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
