import assert from "node:assert/strict";
import { changedLineKey, textContent } from "./review-span.ts";
import type {
  ChangedLineRef,
  ChangeSide,
  DiffLine,
  FileChange,
  ResolvedSpan,
  ReviewComment,
  ReviewRoute,
  ReviewSnapshot,
  ReviewUnitId,
} from "./types.ts";

export const REVIEW_COMMENT_CONTEXT_RADIUS = 3;

export interface ReviewCommentAnchor extends ChangedLineRef {
  readonly reviewUnitId: ReviewUnitId;
}

export interface ReviewCommentInput extends ReviewCommentAnchor {
  readonly body: string;
}

/** A line the reviewer may comment on, together with everything needed to display it. */
export interface ReviewCommentTarget extends ReviewCommentAnchor {
  readonly snapshotId: SnapshotIdOf;
  readonly filePath: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly diffLine: DiffLine;
}

type SnapshotIdOf = ReviewSnapshot["id"];

export type ReviewCommentInputErrorCode = "blank-comment-body";

export class ReviewCommentInputError extends Error {
  readonly code: ReviewCommentInputErrorCode;

  constructor(code: ReviewCommentInputErrorCode, message: string) {
    super(message);
    this.name = "ReviewCommentInputError";
    this.code = code;
  }
}

export type ReviewSessionErrorCode = "unknown-comment-anchor";

export class ReviewSessionError extends Error {
  readonly code: ReviewSessionErrorCode;

  constructor(code: ReviewSessionErrorCode, message: string) {
    super(message);
    this.name = "ReviewSessionError";
    this.code = code;
  }
}

interface InternalTarget extends ReviewCommentTarget {
  readonly fileLines: readonly DiffLine[];
  readonly lineIndex: number;
  readonly order: number;
}

interface StoredComment {
  readonly comment: ReviewComment;
  readonly order: number;
}

/**
 * Comment drafts for one frozen snapshot and one validated route.
 *
 * Only lines that a review unit actually covers can be commented on, so the
 * comment set can never drift outside the route the human is walking.
 */
export class ReviewSession {
  private readonly snapshot: ReviewSnapshot;
  private readonly orderedTargets: readonly InternalTarget[];
  private readonly targetsByAnchor: ReadonlyMap<string, InternalTarget>;
  private readonly commentsByAnchor = new Map<string, StoredComment>();

  constructor(snapshot: ReviewSnapshot, route: ReviewRoute) {
    this.snapshot = structuredClone(snapshot);
    const targets = buildCommentTargets(this.snapshot, route);
    this.orderedTargets = targets;
    this.targetsByAnchor = new Map(
      targets.map((target) => [anchorKey(target), target]),
    );
  }

  get snapshotId(): SnapshotIdOf {
    return this.snapshot.id;
  }

  listCommentableLines(): readonly ReviewCommentTarget[] {
    return this.orderedTargets.map(copyTarget);
  }

  getComments(): readonly ReviewComment[] {
    return [...this.commentsByAnchor.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ comment }) => copyComment(comment));
  }

  getComment(anchor: ReviewCommentAnchor): ReviewComment | undefined {
    const stored = this.commentsByAnchor.get(anchorKey(anchor));
    return stored === undefined ? undefined : copyComment(stored.comment);
  }

  upsertComment(input: ReviewCommentInput): ReviewComment {
    if (input.body.trim().length === 0) {
      throw new ReviewCommentInputError(
        "blank-comment-body",
        "Review comment body must not be blank.",
      );
    }

    const key = anchorKey(input);
    const target = this.targetsByAnchor.get(key);
    if (target === undefined) {
      throw new ReviewSessionError(
        "unknown-comment-anchor",
        `Review unit ${input.reviewUnitId} does not cover ${input.side} line ${input.line} of file change ${input.fileChangeId}.`,
      );
    }

    const comment = materializeComment(target, input.body);
    this.commentsByAnchor.set(key, { comment, order: target.order });
    return copyComment(comment);
  }

  deleteComment(anchor: ReviewCommentAnchor): { readonly deleted: boolean } {
    return { deleted: this.commentsByAnchor.delete(anchorKey(anchor)) };
  }
}

export function listCommentTargets(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): readonly ReviewCommentTarget[] {
  return new ReviewSession(snapshot, route).listCommentableLines();
}

function buildCommentTargets(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): readonly InternalTarget[] {
  const changesById = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );
  const targets: InternalTarget[] = [];
  const seen = new Set<string>();

  for (const unit of route.units) {
    for (const span of unit.spans) {
      const change = changesById.get(span.fileChangeId);
      assert.ok(
        change,
        `Validated route references missing file change ${span.fileChangeId}.`,
      );
      const content = textContent(change);
      assert.ok(
        content,
        `Validated route references non-text file change ${span.fileChangeId}.`,
      );

      for (const [lineIndex, diffLine] of content.lines.entries()) {
        if (!spanContains(span, diffLine)) continue;
        const side: ChangeSide | undefined =
          diffLine.type === "added"
            ? "new"
            : diffLine.type === "removed"
              ? "old"
              : undefined;
        const number =
          side === "new"
            ? diffLine.newLine
            : side === "old"
              ? diffLine.oldLine
              : undefined;
        if (side === undefined || number === undefined) continue;

        const anchor = {
          reviewUnitId: unit.id,
          fileChangeId: change.id,
          side,
          line: number,
        };
        const key = anchorKey(anchor);
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({
          ...anchor,
          snapshotId: snapshot.id,
          filePath: commentFilePath(change, side),
          oldPath: change.oldPath,
          newPath: change.newPath,
          diffLine: { ...diffLine },
          fileLines: content.lines,
          lineIndex,
          order: targets.length,
        });
      }
    }
  }

  return targets;
}

function spanContains(span: ResolvedSpan, line: DiffLine): boolean {
  if (
    line.oldLine !== undefined &&
    span.oldStart !== undefined &&
    span.oldEnd !== undefined &&
    line.oldLine >= span.oldStart &&
    line.oldLine <= span.oldEnd
  ) {
    return true;
  }
  return (
    line.newLine !== undefined &&
    span.newStart !== undefined &&
    span.newEnd !== undefined &&
    line.newLine >= span.newStart &&
    line.newLine <= span.newEnd
  );
}

function commentFilePath(change: FileChange, side: ChangeSide): string {
  const filePath =
    side === "old"
      ? (change.oldPath ?? change.newPath)
      : (change.newPath ?? change.oldPath);
  assert.ok(filePath, `Text file change ${change.id} has no old or new path.`);
  return filePath;
}

function materializeComment(
  target: InternalTarget,
  body: string,
): ReviewComment {
  const start = Math.max(0, target.lineIndex - REVIEW_COMMENT_CONTEXT_RADIUS);
  const end = Math.min(
    target.fileLines.length,
    target.lineIndex + REVIEW_COMMENT_CONTEXT_RADIUS + 1,
  );
  return {
    snapshotId: target.snapshotId,
    reviewUnitId: target.reviewUnitId,
    fileChangeId: target.fileChangeId,
    side: target.side,
    line: target.line,
    filePath: target.filePath,
    oldPath: target.oldPath,
    newPath: target.newPath,
    oldLine: target.diffLine.oldLine,
    newLine: target.diffLine.newLine,
    selectedText: target.diffLine.text,
    nearbyContext: target.fileLines.slice(start, end).map((line) => ({
      ...line,
    })),
    body,
  };
}

function copyTarget(target: InternalTarget): ReviewCommentTarget {
  return {
    reviewUnitId: target.reviewUnitId,
    fileChangeId: target.fileChangeId,
    side: target.side,
    line: target.line,
    snapshotId: target.snapshotId,
    filePath: target.filePath,
    oldPath: target.oldPath,
    newPath: target.newPath,
    diffLine: { ...target.diffLine },
  };
}

function copyComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    nearbyContext: comment.nearbyContext.map((line) => ({ ...line })),
  };
}

function anchorKey(anchor: ReviewCommentAnchor): string {
  return `${anchor.reviewUnitId}\u0000${changedLineKey(anchor)}`;
}
