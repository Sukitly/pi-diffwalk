import {
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ReviewCommentTarget } from "../review/comments.ts";
import { textContent } from "../review/span.ts";
import type {
  DiffLine,
  FileChange,
  ReviewComment,
  ReviewUnit,
} from "../review/types.ts";
import {
  DIFF_GUTTER_WIDTH,
  diffColor,
  diffLineText,
  renderDiffLine,
} from "../ui/diff-line.ts";
import { clamp } from "../ui/layout.ts";
import { safeText } from "../ui/text.ts";
import {
  anchoredChecksByLine,
  INLINE_DIFF_MAX_LINE_LENGTH,
  omissionDetail,
  renderChangeHeader,
  renderInlineChecks,
  renderInlineDiffPair,
} from "./diff-view.ts";
import { GuidedReviewUiInvariantError } from "./errors.ts";
import type {
  ChangedLineDisplayOwnership,
  DisplayOmissionReason,
  ReviewUiTheme,
} from "./types.ts";
import {
  diffLineKey,
  fileLineKey,
  requireDisplayOwnership,
} from "./view-model.ts";

interface CommentTargetPreview {
  readonly path: string;
  readonly anchorRows: readonly string[];
  readonly beforeRows: readonly string[];
  readonly afterRows: readonly string[];
}

export function buildCommentTargetPreview(
  target: ReviewCommentTarget,
  unit: ReviewUnit | undefined,
  changesById: ReadonlyMap<FileChange["id"], FileChange>,
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  comments: readonly ReviewComment[],
  theme: ReviewUiTheme,
  width: number,
): CommentTargetPreview {
  if (unit === undefined || unit.id !== target.reviewUnitId) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} is not part of the current review unit.`,
    );
  }
  const change = changesById.get(target.fileChangeId);
  if (change === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} references file change ${target.fileChangeId}, which is not in the frozen snapshot.`,
    );
  }
  const content = textContent(change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} has no frozen text content.`,
    );
  }
  const anchor = target.context.lines[target.context.anchorIndex];
  if (anchor === undefined || !isCommentTargetLine(target, anchor)) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} has an invalid frozen context anchor.`,
    );
  }
  const fileIndexes = target.context.lines.map(
    (_line, index) => target.context.fileStartIndex + index,
  );
  const inlineTextByFileIndex = buildInlineDiffTextForFileIndexes(
    content.lines,
    fileIndexes,
    theme,
  );
  const commentedLines = new Set(
    comments.map((comment) =>
      fileLineKey(comment.fileChangeId, comment.side, comment.line),
    ),
  );
  const rows = target.context.lines.map((line, index) => {
    const fileIndex = target.context.fileStartIndex + index;
    const selected = index === target.context.anchorIndex;
    if (line.type !== "context") {
      const lineOwnership = requireDisplayOwnership(
        ownership,
        target.fileChangeId,
        line,
      );
      if (
        lineOwnership.type !== "unit" ||
        lineOwnership.reviewUnitId !== unit.id
      ) {
        return [
          renderCompactCommentOmission(
            commentOmissionReason(lineOwnership),
            theme,
            width,
          ),
        ];
      }
    }
    const key = diffLineKey(target.fileChangeId, line);
    const hasComment = key !== undefined && commentedLines.has(key);
    if (selected) {
      const checks =
        anchoredChecksByLine(unit).get(
          fileLineKey(target.fileChangeId, target.side, target.line),
        ) ?? [];
      return [
        ...renderDiffLine(
          line,
          { selected: true, hasComment },
          theme,
          width,
          inlineTextByFileIndex.get(fileIndex),
        ),
        ...renderInlineChecks(checks, theme, width),
      ];
    }
    return [
      renderCompactDiffLine(
        line,
        hasComment,
        theme,
        width,
        inlineTextByFileIndex.get(fileIndex),
      ),
    ];
  });
  return {
    path: truncateToWidth(renderChangeHeader(change, theme), width, "…", true),
    anchorRows: rows[target.context.anchorIndex] ?? [],
    beforeRows: rows.slice(0, target.context.anchorIndex).flat(),
    afterRows: rows.slice(target.context.anchorIndex + 1).flat(),
  };
}

export function commentTargetMandatoryHeight(
  preview: CommentTargetPreview,
  maxRows: number,
): number {
  if (maxRows <= 0) return 0;
  if (maxRows === 1) return 1;
  return 1 + Math.min(preview.anchorRows.length, maxRows - 1);
}

export function renderCommentTargetPreview(
  preview: CommentTargetPreview,
  mandatoryRows: number,
  contextRows: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (mandatoryRows <= 0) return [];
  if (mandatoryRows === 1) {
    return [truncateRenderedRows(preview.anchorRows, 1, theme, width)[0] ?? ""];
  }
  const visibleAnchor = truncateRenderedRows(
    preview.anchorRows,
    mandatoryRows - 1,
    theme,
    width,
  );
  if (visibleAnchor.length < preview.anchorRows.length) {
    return [preview.path, ...visibleAnchor];
  }
  const context = selectCommentContextRows(
    preview.beforeRows,
    preview.afterRows,
    contextRows,
  );
  return [preview.path, ...context.before, ...visibleAnchor, ...context.after];
}

function truncateRenderedRows(
  rows: readonly string[],
  height: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (height <= 0 || rows.length === 0) return [];
  if (rows.length <= height) return [...rows];
  const visible = rows.slice(0, height);
  visible[visible.length - 1] = appendTruncationMarker(
    visible.at(-1) ?? "",
    theme,
    width,
  );
  return visible;
}

function appendTruncationMarker(
  row: string,
  theme: ReviewUiTheme,
  width: number,
): string {
  if (width <= 1) return theme.fg("dim", "…");
  return `${truncateToWidth(row, width - 1, "", true)}${theme.fg("dim", "…")}`;
}

function selectCommentContextRows(
  before: readonly string[],
  after: readonly string[],
  height: number,
): { readonly before: readonly string[]; readonly after: readonly string[] } {
  let beforeCount = 0;
  let afterCount = 0;
  while (beforeCount + afterCount < height) {
    if (
      beforeCount < before.length &&
      (beforeCount <= afterCount || afterCount >= after.length)
    ) {
      beforeCount += 1;
    } else if (afterCount < after.length) {
      afterCount += 1;
    } else {
      break;
    }
  }
  return {
    before: before.slice(before.length - beforeCount),
    after: after.slice(0, afterCount),
  };
}

function commentOmissionReason(
  ownership: ChangedLineDisplayOwnership,
): DisplayOmissionReason {
  switch (ownership.type) {
    case "carried-forward":
      return { type: "carried-forward" };
    case "skipped":
      return { type: "skipped", reason: ownership.reason };
    case "unit":
      return { type: "other-unit", unitTitle: ownership.unitTitle };
  }
}

function renderCompactCommentOmission(
  reason: DisplayOmissionReason,
  theme: ReviewUiTheme,
  width: number,
): string {
  return truncateToWidth(
    `${" ".repeat(DIFF_GUTTER_WIDTH)}${theme.fg("dim", `⋯ ${safeText(omissionDetail({ type: "omission", count: 1, reason }))}`)}`,
    width,
    "…",
    true,
  );
}

function renderCompactDiffLine(
  line: DiffLine,
  hasComment: boolean,
  theme: ReviewUiTheme,
  width: number,
  inlineText?: string,
): string {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = hasComment ? "●" : " ";
  const prefix = `${marker} ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const raw = theme.fg(
    diffColor(line),
    inlineText ?? safeText(diffLineText(line)),
  );
  return truncateToWidth(`${prefix}${raw}`, width, "…", true);
}

function buildInlineDiffTextForFileIndexes(
  lines: readonly DiffLine[],
  fileIndexes: readonly number[],
  theme: ReviewUiTheme,
): ReadonlyMap<number, string> {
  const rendered = new Map<number, string>();
  for (const fileIndex of new Set(fileIndexes)) {
    const pair = oneLineReplacementAt(lines, fileIndex);
    if (pair === undefined || rendered.has(pair.removedIndex)) continue;
    const removed = lines[pair.removedIndex];
    const added = lines[pair.addedIndex];
    if (
      removed === undefined ||
      added === undefined ||
      removed.text.length > INLINE_DIFF_MAX_LINE_LENGTH ||
      added.text.length > INLINE_DIFF_MAX_LINE_LENGTH
    ) {
      continue;
    }
    const inline = renderInlineDiffPair(removed.text, added.text, theme);
    rendered.set(pair.removedIndex, `-${inline.removed}`);
    rendered.set(pair.addedIndex, `+${inline.added}`);
  }
  return rendered;
}

function oneLineReplacementAt(
  lines: readonly DiffLine[],
  fileIndex: number,
): { readonly removedIndex: number; readonly addedIndex: number } | undefined {
  const line = lines[fileIndex];
  if (line?.type !== "removed" && line?.type !== "added") return undefined;
  let addedStart = fileIndex;
  if (line.type === "added") {
    while (lines[addedStart - 1]?.type === "added") addedStart -= 1;
  } else {
    while (lines[addedStart]?.type === "removed") addedStart += 1;
  }
  let removedStart = addedStart;
  while (lines[removedStart - 1]?.type === "removed") removedStart -= 1;
  let addedEnd = addedStart;
  while (lines[addedEnd]?.type === "added") addedEnd += 1;
  if (addedStart - removedStart !== 1 || addedEnd - addedStart !== 1) {
    return undefined;
  }
  const removedIndex = removedStart;
  const addedIndex = addedStart;
  if (fileIndex !== removedIndex && fileIndex !== addedIndex) return undefined;
  return { removedIndex, addedIndex };
}

function isCommentTargetLine(
  target: ReviewCommentTarget,
  line: DiffLine,
): boolean {
  return target.side === "old"
    ? line.type === "removed" && line.oldLine === target.line
    : line.type === "added" && line.newLine === target.line;
}

export function sliceEditorRows(
  lines: readonly string[],
  height: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (height <= 0) return [];
  if (lines.length <= height) return [...lines];
  const cursorIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (height === 1) {
    return [lines[cursorIndex < 0 ? lines.length - 2 : cursorIndex] ?? ""];
  }
  if (height === 2) {
    const cursor =
      lines[cursorIndex < 0 ? lines.length - 2 : cursorIndex] ?? "";
    return [
      cursor,
      renderEditorClipBorder("↓", lines.length - 1, theme, width),
    ];
  }
  const topBorder = lines[0] ?? "";
  const bottomBorder = lines.at(-1) ?? "";
  const content = lines.slice(1, -1);
  const contentHeight = height - 2;
  const contentCursorIndex = content.findIndex((line) =>
    line.includes(CURSOR_MARKER),
  );
  const start = clamp(
    (contentCursorIndex < 0 ? content.length - 1 : contentCursorIndex) -
      Math.floor(contentHeight / 2),
    0,
    content.length - contentHeight,
  );
  const end = start + contentHeight;
  const hiddenAbove = editorBorderHiddenCount(topBorder, "↑") + start;
  const hiddenBelow =
    editorBorderHiddenCount(bottomBorder, "↓") + content.length - end;
  return [
    hiddenAbove > 0
      ? renderEditorClipBorder("↑", hiddenAbove, theme, width)
      : topBorder,
    ...content.slice(start, end),
    hiddenBelow > 0
      ? renderEditorClipBorder("↓", hiddenBelow, theme, width)
      : bottomBorder,
  ];
}

function editorBorderHiddenCount(border: string, direction: "↑" | "↓"): number {
  const match = border.match(new RegExp(`${direction} (\\d+) more`));
  return match === null ? 0 : Number(match[1]);
}

function renderEditorClipBorder(
  direction: "↑" | "↓",
  hiddenRows: number,
  theme: ReviewUiTheme,
  width: number,
): string {
  const indicator = `─── ${direction} ${hiddenRows} more `;
  const line = `${indicator}${"─".repeat(Math.max(0, width - visibleWidth(indicator)))}`;
  return theme.fg("accent", truncateToWidth(line, width, "", true));
}
