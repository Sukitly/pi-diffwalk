import { truncateToWidth } from "@earendil-works/pi-tui";
import type { DiffLine } from "../review/types.ts";
import { safeText, wrapWithPrefix } from "./text.ts";
import type { ThemeColor, UiTheme } from "./theme.ts";

/** Marker column, old line number, new line number, and their separators. */
export const DIFF_GUTTER_WIDTH = 14;

export interface DiffLineMarks {
  readonly selected?: boolean;
  readonly hasComment?: boolean;
  readonly external?: boolean;
}

/** The marker column shows one state: selection, then comment. */
export function diffLineMarker(marks: DiffLineMarks): string {
  if (marks.selected) return ">";
  if (marks.hasComment) return "●";
  if (marks.external) return "·";
  return " ";
}

export function diffColor(line: DiffLine): ThemeColor {
  switch (line.type) {
    case "added":
      return "toolDiffAdded";
    case "removed":
      return "toolDiffRemoved";
    case "context":
      return "toolDiffContext";
  }
}

/** Restores the unified diff prefix that the frozen model stores separately. */
export function diffLineText(line: DiffLine): string {
  const prefix =
    line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  return `${prefix}${line.text}`;
}

export function renderDiffLine(
  line: DiffLine,
  marks: DiffLineMarks,
  theme: UiTheme,
  width: number,
  inlineText?: string,
): readonly string[] {
  const selected = marks.selected === true;
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = diffLineMarker(marks);
  const prefix = `${marker} ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const raw = theme.fg(
    diffColor(line),
    inlineText ?? safeText(diffLineText(line)),
  );
  const lines = wrapWithPrefix(prefix, raw, width);
  if (!selected) return lines;
  return lines.map((rendered) =>
    theme.bg("selectedBg", truncateToWidth(rendered, width, "", true)),
  );
}
