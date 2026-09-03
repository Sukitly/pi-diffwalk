import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeBackground, UiTheme } from "./theme.ts";

export const WIDE_HEADER_WIDTH = 88;
export const MEDIUM_HEADER_WIDTH = 48;

export interface PrioritizedLineGroup {
  readonly lines: readonly string[];
  readonly priority: number;
  readonly minimumRows?: number;
}

export interface ProgressBarSegments {
  readonly leftBoundary: string;
  readonly completed: number;
  readonly remaining: number;
  readonly rightBoundary: string;
}

export function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

/** Pads a fitted line with spaces so a background color covers the full width. */
export function fillLine(line: string, width: number): string {
  const fitted = fitLine(line, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

export function fitColumns(left: string, right: string, width: number): string {
  const available = Math.max(1, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth + 2 >= available) return fitLine(left, available);
  const leftWidth = available - rightWidth - 2;
  const fittedLeft = truncateToWidth(left, leftWidth, "…", true);
  const gap = " ".repeat(
    Math.max(2, available - visibleWidth(fittedLeft) - rightWidth),
  );
  return fitLine(`${fittedLeft}${gap}${right}`, available);
}

export function packStatusParts(
  parts: readonly string[],
  width: number,
): readonly string[] {
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current.length === 0 ? part : `${current} · ${part}`;
    if (current.length > 0 && visibleWidth(candidate) > width) {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Keeps complete header groups in priority order while preserving their visual
 * order. reservedRows belongs to body content and the footer, so optional
 * status groups cannot consume the whole terminal.
 */
export function selectHeaderGroups(
  groups: readonly PrioritizedLineGroup[],
  terminalRows: number,
  reservedRows = 2,
): readonly string[] {
  const rows = Math.max(1, Math.floor(terminalRows));
  const budget = Math.max(0, rows - Math.max(0, reservedRows));
  const eligible = groups
    .map((group, index) => ({ group, index }))
    .filter(
      ({ group }) => group.lines.length > 0 && rows >= (group.minimumRows ?? 1),
    )
    .sort(
      (left, right) =>
        right.group.priority - left.group.priority || left.index - right.index,
    );
  const selected = new Set<number>();
  let used = 0;
  for (const { group, index } of eligible) {
    if (used + group.lines.length > budget) continue;
    selected.add(index);
    used += group.lines.length;
  }
  return groups.flatMap((group, index) =>
    selected.has(index) ? [...group.lines] : [],
  );
}

export function progressBarSegments(
  reviewed: number,
  total: number,
  width = 12,
): ProgressBarSegments {
  const available = Math.max(0, Math.floor(width));
  const leftBoundary = available >= 1 ? "[" : "";
  const rightBoundary = available >= 2 ? "]" : "";
  const trackWidth = Math.max(
    0,
    available - leftBoundary.length - rightBoundary.length,
  );
  const boundedTotal = Math.max(0, total);
  const boundedReviewed = Math.max(0, Math.min(reviewed, boundedTotal));
  let completed = 0;
  if (boundedTotal > 0 && boundedReviewed >= boundedTotal) {
    completed = trackWidth;
  } else if (boundedReviewed > 0 && trackWidth > 1) {
    const rounded = Math.round((boundedReviewed / boundedTotal) * trackWidth);
    completed = Math.max(1, Math.min(trackWidth - 1, rounded));
  }
  return {
    leftBoundary,
    completed,
    remaining: trackWidth - completed,
    rightBoundary,
  };
}

export function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function clampOffset(
  offset: number,
  contentLength: number,
  viewportHeight: number,
): number {
  return clamp(
    offset,
    0,
    Math.max(0, contentLength - Math.max(0, viewportHeight)),
  );
}

export function clampedMargin(width: number, margin: number): number {
  return Math.min(Math.max(0, margin), Math.max(0, width - 1));
}

export function widthAfterMargin(width: number, margin: number): number {
  return Math.max(1, width - clampedMargin(width, margin));
}

/** Pads a screen to the terminal height while keeping the last line as the footer. */
export function fillScreenHeight(
  lines: readonly string[],
  rows: number,
): readonly string[] {
  if (lines.length >= rows) return lines.slice(0, rows);
  const footer = lines.at(-1) ?? "";
  return [
    ...lines.slice(0, -1),
    ...Array.from({ length: rows - lines.length }, () => ""),
    footer,
  ];
}

export function renderBackgroundBlock(
  lines: readonly string[],
  background: ThemeBackground,
  theme: UiTheme,
  width: number,
  leftMargin: number,
): readonly string[] {
  const margin = clampedMargin(width, leftMargin);
  const backgroundWidth = widthAfterMargin(width, leftMargin);
  const prefix = " ".repeat(margin);
  return lines.map(
    (line) =>
      `${prefix}${theme.bg(background, fillLine(line, backgroundWidth))}`,
  );
}
