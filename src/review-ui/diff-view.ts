import { diffWords } from "diff";
import type { ReviewCommentTarget } from "../review/comments.ts";
import type {
  DiffLine,
  FileChange,
  ReviewCheck,
  ReviewComment,
  ReviewUnit,
} from "../review/types.ts";
import { DIFF_GUTTER_WIDTH, renderDiffLine } from "../ui/diff-line.ts";
import {
  clampedMargin,
  fillLine,
  fitLine,
  renderBackgroundBlock,
  widthAfterMargin,
} from "../ui/layout.ts";
import { displayBareChangePath } from "../ui/paths.ts";
import { safeText, wrapStyled, wrapWithPrefix } from "../ui/text.ts";
import type {
  InventoryEntry,
  PlannedDiffLine,
  PlannedDiffOmission,
  RenderedRow,
  ReviewUiTheme,
  UnitDisplayBlock,
  UnitView,
} from "./types.ts";
import { fileLineKey, lineTarget, targetKey } from "./view-model.ts";

export function renderUnitDiff(
  unit: UnitView,
  selectedTarget: ReviewCommentTarget | undefined,
  comments: readonly ReviewComment[],
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  const targetsByLine = new Map(
    unit.targets.map((target) => [
      fileLineKey(target.fileChangeId, target.side, target.line),
      target,
    ]),
  );
  const commentsByTarget = new Map(
    comments.map((comment) => [targetKey(comment), comment]),
  );
  const checksByLine = anchoredChecksByLine(unit.unit);

  for (const [displayBlockIndex, block] of unit.displayBlocks.entries()) {
    if (rows.length > 0) rows.push({ text: "" });
    rows.push(
      ...wrapStyled(renderChangeHeader(block.change, theme), width).map(
        (text) => ({
          text,
          displayBlockIndex,
          isBlockHeader: true,
        }),
      ),
      ...renderPlannedDiffItems(
        block,
        displayBlockIndex,
        targetsByLine,
        commentsByTarget,
        checksByLine,
        selectedTarget,
        theme,
        width,
      ),
    );
  }
  return rows;
}

export function anchoredChecksByLine(
  unit: ReviewUnit,
): ReadonlyMap<string, readonly ReviewCheck[]> {
  const byLine = new Map<string, ReviewCheck[]>();
  for (const check of unit.reviewFocus) {
    if (check.anchor === undefined) continue;
    const key = fileLineKey(
      check.anchor.fileChangeId,
      check.anchor.side,
      check.anchor.line,
    );
    const list = byLine.get(key) ?? [];
    list.push(check);
    byLine.set(key, list);
  }
  return byLine;
}

function renderPlannedDiffItems(
  block: UnitDisplayBlock,
  displayBlockIndex: number,
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  commentsByTarget: ReadonlyMap<string, ReviewComment>,
  checksByLine: ReadonlyMap<string, readonly ReviewCheck[]>,
  selectedTarget: ReviewCommentTarget | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  let buffered: PlannedDiffLine[] = [];
  let externalDetail: string | undefined;
  const flush = (): void => {
    if (buffered.length === 0) return;
    rows.push(
      ...renderUnitDiffLines(
        buffered,
        displayBlockIndex,
        block.change.id,
        targetsByLine,
        commentsByTarget,
        checksByLine,
        selectedTarget,
        theme,
        width,
      ),
    );
    buffered = [];
  };

  for (const item of block.items) {
    if (item.type === "omission") {
      flush();
      externalDetail = undefined;
      rows.push(renderOmittedDiffLines(item, displayBlockIndex, theme, width));
      continue;
    }
    if (item.externalDetail !== externalDetail) {
      flush();
      externalDetail = item.externalDetail;
      if (externalDetail !== undefined) {
        rows.push(
          ...renderExternalLineNotice(
            externalDetail,
            displayBlockIndex,
            theme,
            width,
          ),
        );
      }
    }
    buffered.push(item);
  }
  flush();
  return rows;
}

function renderUnitDiffLines(
  lines: readonly PlannedDiffLine[],
  displayBlockIndex: number,
  fileChangeId: FileChange["id"],
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  commentsByTarget: ReadonlyMap<string, ReviewComment>,
  checksByLine: ReadonlyMap<string, readonly ReviewCheck[]>,
  selectedTarget: ReviewCommentTarget | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  const inlineTextByIndex = buildInlineDiffText(
    lines.map(({ line }) => line),
    theme,
  );
  for (const [lineIndex, planned] of lines.entries()) {
    const line = planned.line;
    const target =
      planned.role === "owned"
        ? lineTarget(targetsByLine, fileChangeId, line)
        : undefined;
    const isSelected =
      target !== undefined &&
      selectedTarget !== undefined &&
      targetKey(target) === targetKey(selectedTarget);
    const comment =
      target === undefined
        ? undefined
        : commentsByTarget.get(targetKey(target));
    const checks =
      target === undefined
        ? []
        : (checksByLine.get(
            fileLineKey(target.fileChangeId, target.side, target.line),
          ) ?? []);
    const lineRows = renderDiffLine(
      line,
      {
        selected: isSelected,
        hasComment: comment !== undefined,
        external: planned.role === "external",
      },
      theme,
      width,
      inlineTextByIndex.get(lineIndex),
    );
    rows.push(
      ...(checks.length > 0 && !isSelected
        ? lineRows.map((text) => fillCheckBlockRow(text, theme, width))
        : lineRows
      ).map((text) => ({
        text,
        displayBlockIndex,
        targetKey: target === undefined ? undefined : targetKey(target),
      })),
    );
    if (target !== undefined) {
      rows.push(
        ...renderInlineChecks(checks, theme, width).map((text) => ({
          text,
          displayBlockIndex,
          targetKey: targetKey(target),
        })),
      );
    }
    if (comment !== undefined && target !== undefined) {
      rows.push(
        ...renderInlineDraftComment(comment, theme, width).map((text) => ({
          text,
          displayBlockIndex,
          targetKey: targetKey(target),
        })),
      );
    }
  }
  return rows;
}

const CHECK_BLOCK_BG: Parameters<ReviewUiTheme["bg"]>[0] = "customMessageBg";

/** Paints one full-width row of the block a line shares with its questions. */
function fillCheckBlockRow(
  text: string,
  theme: ReviewUiTheme,
  width: number,
): string {
  return theme.bg(CHECK_BLOCK_BG, fillLine(text, width));
}

/**
 * Review questions anchored to one diff line. They continue the background
 * block started by the line, indented to the diff gutter, so the line and its
 * questions read as one card.
 */
export function renderInlineChecks(
  checks: readonly ReviewCheck[],
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (checks.length === 0) return [];
  const margin = " ".repeat(clampedMargin(width, DIFF_GUTTER_WIDTH));
  const wrapWidth = Math.min(width, margin.length + COMMENT_CARD_MAX_WIDTH);
  return checks
    .flatMap((check) =>
      wrapWithPrefix(
        margin,
        theme.fg("text", safeText(check.question)),
        wrapWidth,
      ),
    )
    .map((row) => fillCheckBlockRow(row, theme, width));
}

function renderOmittedDiffLines(
  omission: PlannedDiffOmission,
  displayBlockIndex: number,
  theme: ReviewUiTheme,
  width: number,
): RenderedRow {
  const detail = omissionDetail(omission);
  return {
    text: fitLine(
      `${" ".repeat(DIFF_GUTTER_WIDTH)}${theme.fg("dim", `⋯ ${safeText(detail)}`)}`,
      width,
    ),
    displayBlockIndex,
  };
}

export function omissionDetail(omission: PlannedDiffOmission): string {
  const lines = `${omission.count} frozen diff line${omission.count === 1 ? "" : "s"}`;
  switch (omission.reason.type) {
    case "distant":
      return `${lines} not shown`;
    case "gap": {
      const { carriedForward, skipped, otherUnit, shownLater } =
        omission.reason;
      const parts = [
        carriedForward > 0
          ? `${carriedForward} reviewed in an earlier round`
          : undefined,
        skipped > 0 ? `${skipped} skipped` : undefined,
        otherUnit > 0 ? `${otherUnit} routed to other units` : undefined,
        shownLater > 0 ? `${shownLater} shown later in this unit` : undefined,
      ].filter((part) => part !== undefined);
      return parts.length === 0
        ? `${lines} not shown`
        : `${lines} not shown; ${parts.join(", ")}`;
    }
    case "route-jump":
      return "routed region continues elsewhere in this file";
    case "carried-forward":
      return `${lines} not shown; reviewed in an earlier round`;
    case "skipped":
      return `${lines} not shown; skipped: ${omission.reason.reason}`;
    case "other-unit":
      return `${lines} not shown; routed to unit ${JSON.stringify(omission.reason.unitTitle)}`;
    case "shown-earlier":
      return `${lines} already shown earlier in this unit`;
    case "shown-later":
      return `${lines} shown later in this unit`;
  }
}

function renderExternalLineNotice(
  detail: string,
  displayBlockIndex: number,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  return wrapWithPrefix(
    " ".repeat(DIFF_GUTTER_WIDTH),
    theme.fg("dim", `· ${safeText(detail)}`),
    width,
  ).map((text) => ({ text, displayBlockIndex }));
}

/** Highlighted file path shown above a route-ordered display block. */
export function renderChangeHeader(
  change: FileChange,
  theme: ReviewUiTheme,
): string {
  return theme.fg("accent", theme.bold(displayBareChangePath(change)));
}

export function renderReadOnlyFile(
  entry: Extract<InventoryEntry, { readonly type: "file" }>,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines = [
    ...wrapStyled(theme.fg("accent", theme.bold(safeText(entry.title))), width),
    ...wrapStyled(theme.fg("muted", safeText(entry.detail)), width),
    "",
  ];
  for (const [index, region] of entry.regions.entries()) {
    if (index > 0) lines.push("");
    const inlineTextByIndex = buildInlineDiffText(region, theme);
    for (const [lineIndex, line] of region.entries()) {
      lines.push(
        ...renderDiffLine(
          line,
          {},
          theme,
          width,
          inlineTextByIndex.get(lineIndex),
        ),
      );
    }
  }
  return lines;
}

export const INLINE_DIFF_MAX_LINE_LENGTH = 1_000;

/**
 * Mirrors Pi's conservative inline-highlighting rule: only pair a replacement
 * block when it contains exactly one removed line followed by one added line.
 * Very long untrusted lines stay line-colored without quadratic word diffing.
 */
function buildInlineDiffText(
  lines: readonly DiffLine[],
  theme: ReviewUiTheme,
): ReadonlyMap<number, string> {
  const rendered = new Map<number, string>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type !== "removed") {
      index += 1;
      continue;
    }

    const removedStart = index;
    while (lines[index]?.type === "removed") index += 1;
    const addedStart = index;
    while (lines[index]?.type === "added") index += 1;
    if (addedStart - removedStart !== 1 || index - addedStart !== 1) continue;

    const removed = lines[removedStart];
    const added = lines[addedStart];
    if (
      removed === undefined ||
      added === undefined ||
      removed.text.length > INLINE_DIFF_MAX_LINE_LENGTH ||
      added.text.length > INLINE_DIFF_MAX_LINE_LENGTH
    ) {
      continue;
    }
    const pair = renderInlineDiffPair(removed.text, added.text, theme);
    rendered.set(removedStart, `-${pair.removed}`);
    rendered.set(addedStart, `+${pair.added}`);
  }
  return rendered;
}

export function renderInlineDiffPair(
  removedText: string,
  addedText: string,
  theme: ReviewUiTheme,
): { readonly removed: string; readonly added: string } {
  const parts = diffWords(safeText(removedText), safeText(addedText));
  let removed = "";
  let added = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of parts) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
        removed += leadingWhitespace;
        value = value.slice(leadingWhitespace.length);
        isFirstRemoved = false;
      }
      if (value.length > 0) removed += theme.inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
        added += leadingWhitespace;
        value = value.slice(leadingWhitespace.length);
        isFirstAdded = false;
      }
      if (value.length > 0) added += theme.inverse(value);
    } else {
      removed += part.value;
      added += part.value;
    }
  }

  return { removed, added };
}

const COMMENT_CARD_MAX_WIDTH = 120;

function renderInlineDraftComment(
  comment: ReviewComment,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const cardWidth = widthAfterMargin(width, DIFF_GUTTER_WIDTH);
  const contentWidth = Math.min(cardWidth, COMMENT_CARD_MAX_WIDTH);
  const content = [
    ...wrapStyled(
      theme.fg("accent", theme.bold("  [Draft comment]")),
      contentWidth,
    ),
    ...wrapWithPrefix(
      "  ",
      theme.fg("text", safeText(comment.body)),
      contentWidth,
    ),
  ];
  return [
    ...renderBackgroundBlock(
      content,
      "userMessageBg",
      theme,
      width,
      DIFF_GUTTER_WIDTH,
    ),
    "",
  ];
}
