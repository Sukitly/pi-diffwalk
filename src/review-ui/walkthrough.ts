import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReviewCheck, ReviewUnit } from "../review/types.ts";
import { fitLine } from "../ui/layout.ts";
import { safeText, wrapStyled, wrapWithPrefix } from "../ui/text.ts";
import type { ReviewUiTheme, TransientFeedback } from "./types.ts";

function renderSectionHeading(label: string, theme: ReviewUiTheme): string {
  return theme.fg("text", theme.bold(label));
}

/** Marks a question that stands on its own: above the diff or in details. */
const CHECK_MARKER = "? ";

function renderCheckRows(
  checks: readonly ReviewCheck[],
  marker: string,
  indent: string,
  contentWidth: number,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  return checks.flatMap((check) =>
    wrapWithPrefix(
      theme.fg("accent", marker),
      theme.fg("text", safeText(check.question)),
      contentWidth,
    ).map((line) => fitLine(`${indent}${line}`, width)),
  );
}

const MINIMUM_BODY_ROWS_WITH_SEPARATOR = 6;

const MINIMUM_DIFF_ROWS_BESIDE_PREVIEW = 8;

const MAXIMUM_SUMMARY_ROWS = 3;

/**
 * The rows between the header and the diff: the change summary so the
 * reviewer knows what this unit does, then the checks that concern the unit
 * as a whole. Anchored checks render beneath their lines inside the diff.
 * Short bodies drop the unit checks first, then the summary, so the diff
 * keeps at least a few rows; the details page always holds everything.
 */
export function renderWalkthroughPreview(
  unit: ReviewUnit,
  bodyHeight: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (bodyHeight < MINIMUM_BODY_ROWS_WITH_SEPARATOR) return [];
  const summary = wrapStyled(
    theme.fg("text", safeText(unit.changeSummary)),
    width,
  );
  if (summary.length > MAXIMUM_SUMMARY_ROWS) {
    summary.length = MAXIMUM_SUMMARY_ROWS;
    summary[MAXIMUM_SUMMARY_ROWS - 1] =
      `${truncateToWidth(summary[MAXIMUM_SUMMARY_ROWS - 1] ?? "", Math.max(0, width - 1), "")}${theme.fg("dim", "…")}`;
  }
  const unitChecks = unit.reviewFocus.filter(
    (check) => check.anchor === undefined,
  );
  const checks =
    unitChecks.length === 0
      ? []
      : [
          "",
          ...renderCheckRows(
            unitChecks,
            CHECK_MARKER,
            "  ",
            Math.max(1, width - 2),
            theme,
            width,
          ),
        ];
  const candidates = [
    ["", ...summary, ...checks, ""],
    ["", ...summary, ""],
    [""],
  ];
  return (
    candidates.find(
      (rows) => bodyHeight - rows.length >= MINIMUM_DIFF_ROWS_BESIDE_PREVIEW,
    ) ?? [""]
  );
}

export function renderExplanationLines(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const lines: string[] = [];
  addSectionText(lines, "Why this comes next", unit.whyHere, theme, width);
  addSectionText(lines, "Context to keep in mind", unit.context, theme, width);
  addSectionText(lines, "Change", unit.changeSummary, theme, width);
  lines.push("", renderSectionHeading("Review checks", theme));
  for (const check of unit.reviewFocus) {
    const location =
      check.anchor === undefined
        ? theme.fg("dim", " (whole unit)")
        : theme.fg(
            "dim",
            ` (${safeText(check.anchor.path)} ${check.anchor.side} ${check.anchor.line})`,
          );
    lines.push(
      ...wrapWithPrefix(
        theme.fg("accent", CHECK_MARKER),
        `${theme.fg("text", safeText(check.question))}${location}`,
        width,
      ),
    );
  }
  return lines;
}

function addSectionText(
  lines: string[],
  label: string,
  value: string,
  theme: ReviewUiTheme,
  width: number,
): void {
  if (lines.length > 0) lines.push("");
  lines.push(renderSectionHeading(label, theme));
  lines.push(...wrapStyled(theme.fg("text", safeText(value)), width));
}

export function renderTransientFeedback(
  feedback: TransientFeedback | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (feedback === undefined) return [];
  return wrapStyled(
    theme.fg(
      feedback.type === "warning" ? "warning" : "muted",
      safeText(feedback.message),
    ),
    width,
  );
}

const WALKTHROUGH_FOOTERS = [
  "j/k line • ←/→ unit • c comment • d delete • n complete • e details • i inventory • s summary • Esc pause • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • i inventory • s summary • Esc pause • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • i inventory • s summary • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • s summary • ? help",
  "j/k line • ←/→ unit • c comment • n complete • ? help",
  "c comment • ←/→ unit • n finish • ? help",
  "c comment • n finish • ? help",
  "c comment • ? help",
  "? help",
  "?",
] as const;

export function walkthroughFooterText(width: number): string {
  const available = Math.max(1, width);
  return (
    WALKTHROUGH_FOOTERS.find((footer) => visibleWidth(footer) <= available) ??
    "?"
  );
}
