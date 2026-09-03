import { REVIEW_COMMENT_CONTEXT_RADIUS } from "../review/comments.ts";
import type {
  ReviewCommentId,
  ReviewSnapshot,
  ReviewThreadBatch,
} from "../review/types.ts";
import { clampOffset } from "../ui/layout.ts";
import {
  type RenderedThreadRow,
  ReviewThreadUiError,
  type ThreadRegion,
} from "./types.ts";

export function buildThreadRegions(
  snapshot: ReviewSnapshot,
  batch: ReviewThreadBatch,
): readonly ThreadRegion[] {
  const changes = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );
  const regions: ThreadRegion[] = [];

  for (const thread of batch.threads) {
    const change = changes.get(thread.anchor.fileChangeId);
    if (change === undefined) {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references missing file change ${thread.anchor.fileChangeId}.`,
      );
    }
    if (change.content.type !== "text") {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references non-text file change ${change.id}.`,
      );
    }
    const anchorIndex = change.content.lines.findIndex((line) =>
      thread.anchor.side === "new"
        ? line.newLine === thread.anchor.line && line.type === "added"
        : line.oldLine === thread.anchor.line && line.type === "removed",
    );
    if (anchorIndex < 0) {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} anchor is missing from frozen snapshot ${snapshot.id}.`,
      );
    }
    const start = Math.max(0, anchorIndex - REVIEW_COMMENT_CONTEXT_RADIUS);
    const end = Math.min(
      change.content.lines.length - 1,
      anchorIndex + REVIEW_COMMENT_CONTEXT_RADIUS,
    );
    const previous = regions.at(-1);
    if (
      previous !== undefined &&
      previous.change.id === change.id &&
      start <= previous.end + 1
    ) {
      previous.end = Math.max(previous.end, end);
      previous.threads.push(thread);
    } else {
      regions.push({ change, start, end, threads: [thread] });
    }
  }
  return regions;
}

export function ensureThreadVisible(
  rows: readonly RenderedThreadRow[],
  commentId: ReviewCommentId | undefined,
  offset: number,
  viewportHeight: number,
): number {
  if (commentId === undefined || viewportHeight <= 0) return 0;
  const first = rows.findIndex((row) => row.commentId === commentId);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.commentId === commentId) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);
  let next = clampOffset(offset, rows.length, viewportHeight);
  if (last - first + 1 > viewportHeight) {
    if (first >= next + viewportHeight || last < next) next = first;
  } else if (first < next) next = first;
  else if (last >= next + viewportHeight) next = last - viewportHeight + 1;
  return clampOffset(next, rows.length, viewportHeight);
}
