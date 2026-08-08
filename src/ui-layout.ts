import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const WIDE_HEADER_WIDTH = 88;
export const MEDIUM_HEADER_WIDTH = 48;

export interface PrioritizedLineGroup {
  readonly lines: readonly string[];
  readonly priority: number;
  readonly minimumRows?: number;
}

export interface ProgressBarSegments {
  readonly completed: number;
  readonly remaining: number;
}

export function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
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
  const boundedTotal = Math.max(0, total);
  const boundedReviewed = Math.max(0, Math.min(reviewed, boundedTotal));
  const completed =
    boundedTotal === 0
      ? 0
      : Math.round((boundedReviewed / boundedTotal) * available);
  return { completed, remaining: available - completed };
}

export function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
