import type { ReviewCommentTarget } from "../review/comments.ts";
import { clampOffset, fitLine } from "../ui/layout.ts";
import { safeText, wrapStyled } from "../ui/text.ts";
import type {
  DiffViewport,
  InventoryEntry,
  RenderedRow,
  ReviewUiTheme,
} from "./types.ts";
import { SPAN_DISPLAY_CONTEXT_RADIUS, targetKey } from "./view-model.ts";

export function lastTargetKey(
  rows: readonly RenderedRow[],
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const key = rows[index]?.targetKey;
    if (key !== undefined) return key;
  }
  return undefined;
}

/** Smallest diff viewport that can afford to reserve a line for a pinned header. */
export const MIN_PINNED_HEADER_VIEWPORT = 5;

/**
 * Scroll offset and pinned display-block header for the walkthrough diff viewport.
 *
 * When the file header of the block at the top of the viewport has scrolled
 * away, one viewport line is reserved to pin that header so the file name
 * stays visible, and the offset is recomputed so the selected line remains
 * inside the smaller viewport. Viewports shorter than
 * MIN_PINNED_HEADER_VIEWPORT keep every line for content.
 *
 * With anchorToTarget false the offset is only clamped, so paging can move
 * through regions without a commentable line while the selection stays
 * off-screen.
 */
export function resolveDiffViewport(
  rows: readonly RenderedRow[],
  target: ReviewCommentTarget | undefined,
  offset: number,
  height: number,
  anchorToTarget = true,
): DiffViewport {
  let next = anchorToTarget
    ? ensureTargetVisible(rows, target, offset, height)
    : clampOffset(offset, rows.length, height);
  let pinned =
    height >= MIN_PINNED_HEADER_VIEWPORT
      ? stickyBlockIndex(rows, next)
      : undefined;
  if (pinned !== undefined) {
    next = anchorToTarget
      ? ensureTargetVisible(rows, target, next, height - 1)
      : clampOffset(next, rows.length, height - 1);
    pinned = stickyBlockIndex(rows, next);
  }
  return {
    offset: next,
    contentHeight: pinned === undefined ? height : height - 1,
    ...(pinned === undefined ? {} : { pinnedBlockIndex: pinned }),
  };
}

/**
 * Index of the display block whose header must be pinned for the given scroll offset.
 *
 * Returns undefined when the top of the viewport already shows a block header,
 * so the pinned line never duplicates a visible header.
 */
function stickyBlockIndex(
  rows: readonly RenderedRow[],
  offset: number,
): number | undefined {
  if (offset <= 0) return undefined;
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.displayBlockIndex === undefined) continue;
    return row.isBlockHeader ? undefined : row.displayBlockIndex;
  }
  return undefined;
}

/**
 * Single-line file title pinned above the read-only file viewport once the
 * inline title has scrolled out, so the file name stays visible.
 */
export function pinnedFileTitle(
  entry: Extract<InventoryEntry, { readonly type: "file" }>,
  offset: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const title = theme.fg("accent", theme.bold(safeText(entry.title)));
  if (offset < wrapStyled(title, width).length) return [];
  return [fitLine(title, width)];
}

/**
 * Rows kept visible above and below the selected line while scrolling, so
 * the unchanged padding around a span reappears when the cursor returns to
 * the edge of the viewport. Shrinks to fit small viewports.
 */
const DIFF_SCROLL_MARGIN = SPAN_DISPLAY_CONTEXT_RADIUS;

function ensureTargetVisible(
  rows: readonly RenderedRow[],
  target: ReviewCommentTarget | undefined,
  offset: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0 || target === undefined) return 0;
  const selectedKey = targetKey(target);
  const first = rows.findIndex((row) => row.targetKey === selectedKey);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.targetKey === selectedKey) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);

  let next = clampOffset(offset, rows.length, viewportHeight);
  const selectedHeight = last - first + 1;
  if (selectedHeight <= viewportHeight) {
    const margin = Math.min(
      DIFF_SCROLL_MARGIN,
      Math.floor((viewportHeight - selectedHeight) / 2),
    );
    if (first - margin < next) next = Math.max(0, first - margin);
    else if (last + margin >= next + viewportHeight) {
      next = last + margin - viewportHeight + 1;
    }
  } else if (last < next || first >= next + viewportHeight) {
    next = first;
  }
  return clampOffset(next, rows.length, viewportHeight);
}

export function ensureInventorySelectionVisible(
  rows: readonly RenderedRow[],
  selectedIndex: number,
  offset: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0) return 0;
  const first = rows.findIndex((row) => row.inventoryIndex === selectedIndex);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.inventoryIndex === selectedIndex) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);
  let next = clampOffset(offset, rows.length, viewportHeight);
  if (first < next) next = first;
  else if (last >= next + viewportHeight) next = first;
  return clampOffset(next, rows.length, viewportHeight);
}

export function sliceViewport(
  rows: readonly RenderedRow[],
  offset: number,
  height: number,
): readonly RenderedRow[] {
  if (height <= 0) return [];
  return rows.slice(offset, offset + height);
}

export function halfPage(viewportHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / 2));
}
