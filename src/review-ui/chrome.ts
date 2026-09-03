import {
  countNoun,
  fitColumns,
  fitLine,
  MEDIUM_HEADER_WIDTH,
  type PrioritizedLineGroup,
  packStatusParts,
  progressBarSegments,
  selectHeaderGroups,
  WIDE_HEADER_WIDTH,
} from "../ui/layout.ts";
import { safeText } from "../ui/text.ts";
import type { ReviewScreen, ReviewUiTheme, SubmissionStatus } from "./types.ts";

export interface ScreenHeaderState {
  readonly screen: ReviewScreen;
  readonly title: string;
  readonly unitCount: number;
  readonly unitIndex: number;
  readonly reviewedCount: number;
  readonly commentCount: number;
  readonly skippedCount: number;
  readonly unsupportedCount: number;
  readonly submissionStatus: SubmissionStatus;
}

/**
 * Header groups are dropped by priority when the terminal is short, so the
 * brand line survives before the title and the title before the status.
 */
export function renderScreenHeader(
  state: ScreenHeaderState,
  theme: ReviewUiTheme,
  width: number,
  rows: number,
  reservedRows = 2,
): readonly string[] {
  const unitCount = state.unitCount;
  const currentUnit = unitCount === 0 ? 0 : state.unitIndex + 1;
  const reviewed = state.reviewedCount;
  const position = `Unit ${currentUnit}/${unitCount}`;
  const progress = `${reviewed}/${unitCount} reviewed`;
  const comments = countNoun(state.commentCount, "comment");
  const statusParts = [comments, `${state.skippedCount} skipped`];
  if (state.unsupportedCount > 0) {
    statusParts.push(`${state.unsupportedCount} unsupported`);
  }

  const brand = theme.fg(
    "accent",
    theme.bold(`DiffWalk / ${screenLabel(state.screen)}`),
  );
  const title = theme.fg("text", theme.bold(safeText(state.title)));
  const groups: PrioritizedLineGroup[] = [];

  if (width >= WIDE_HEADER_WIDTH) {
    const progressBar = renderProgressBar(reviewed, unitCount, theme);
    const status = `${theme.fg("muted", progress)}    ${theme.fg("muted", statusParts.join(" · "))}    ${progressBar}`;
    groups.push(
      {
        lines: [fitColumns(brand, theme.fg("muted", position), width)],
        priority: 90,
      },
      { lines: [fitLine(title, width)], priority: 80 },
      {
        lines: [fitLine(status, width)],
        priority: 50,
        minimumRows: 5,
      },
    );
  } else if (width >= MEDIUM_HEADER_WIDTH) {
    groups.push(
      {
        lines: [fitLine(`${brand}${theme.fg("dim", ` · ${position}`)}`, width)],
        priority: 90,
      },
      { lines: [fitLine(title, width)], priority: 80 },
      {
        lines: packStatusParts([progress, ...statusParts], width).map((line) =>
          fitLine(theme.fg("muted", line), width),
        ),
        priority: 40,
        minimumRows: 6,
      },
    );
  } else {
    const narrowBrand =
      width >= 28 ? brand : theme.fg("accent", theme.bold("DiffWalk"));
    groups.push(
      {
        lines: [
          fitLine(
            `${narrowBrand}${theme.fg("dim", ` · ${currentUnit}/${unitCount}`)}`,
            width,
          ),
        ],
        priority: 90,
      },
      { lines: [fitLine(title, width)], priority: 80 },
      {
        lines: [
          fitLine(
            theme.fg("muted", `Reviewed ${reviewed}/${unitCount}`),
            width,
          ),
        ],
        priority: 50,
        minimumRows: 6,
      },
      {
        lines: packStatusParts(statusParts, width).map((line) =>
          fitLine(theme.fg("muted", line), width),
        ),
        priority: 40,
        minimumRows: 10,
      },
    );
  }

  groups.push({
    lines: renderSnapshotHeaderAlert(state.submissionStatus, theme, width),
    priority: 100,
  });
  return selectHeaderGroups(groups, rows, reservedRows);
}

export function renderScreenFooter(
  text: string,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  return [fitLine(theme.fg("dim", safeText(text)), width)];
}

function screenLabel(screen: ReviewScreen): string {
  switch (screen) {
    case "walkthrough":
      return "Review";
    case "comment-editor":
      return "Comment";
    case "explanation":
      return "Details";
    case "inventory":
    case "inventory-diff":
      return "Inventory";
    case "summary":
      return "Summary";
    case "help":
      return "Help";
    case "cancel-confirmation":
      return "Pause";
  }
}

function renderProgressBar(
  reviewed: number,
  total: number,
  theme: ReviewUiTheme,
): string {
  const segments = progressBarSegments(reviewed, total);
  const completed = "█".repeat(segments.completed);
  return `${theme.fg("border", segments.leftBoundary)}${
    completed.length === 0 ? "" : theme.fg("accent", completed)
  }${" ".repeat(segments.remaining)}${theme.fg(
    "border",
    segments.rightBoundary,
  )}`;
}

function renderSnapshotHeaderAlert(
  status: SubmissionStatus,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  switch (status) {
    case "not-checked":
      return [];
    case "checking":
      return [
        fitLine(theme.fg("warning", "Snapshot check in progress"), width),
      ];
    case "repository-drifted":
      return [
        fitLine(
          theme.fg("error", "Snapshot changed; submission is blocked"),
          width,
        ),
      ];
    case "verification-failed":
      return [
        fitLine(
          theme.fg("error", "Snapshot check failed; submission is blocked"),
          width,
        ),
      ];
  }
}
