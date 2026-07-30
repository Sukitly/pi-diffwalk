import assert from "node:assert/strict";
import { listSnapshotHunks } from "./review-delta.ts";
import type {
  CancelledGuidedReviewResult,
  DiffLine,
  FileChange,
  HunkId,
  ReviewComment,
  ReviewRoute,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewUnitId,
  SnapshotId,
  SubmittedGuidedReviewResult,
} from "./types.ts";

export const REVIEW_COMMENT_CONTEXT_RADIUS = 3;

export interface ReviewCommentAnchor {
  readonly reviewUnitId: ReviewUnitId;
  readonly hunkId: HunkId;
  readonly diffLineIndex: number;
}

export interface ReviewCommentInput extends ReviewCommentAnchor {
  readonly body: string;
}

export interface ReviewCommentTarget extends ReviewCommentAnchor {
  readonly snapshotId: SnapshotId;
  readonly filePath: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly line: DiffLine;
}

export type ReviewSnapshotVerifier = (
  snapshot: ReviewSnapshot,
  signal: AbortSignal,
) => Promise<void>;

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

interface InternalReviewCommentTarget extends ReviewCommentTarget {
  readonly hunkLines: readonly DiffLine[];
  readonly order: number;
}

interface StoredComment {
  readonly comment: ReviewComment;
  readonly order: number;
}

export class ReviewSession {
  private readonly snapshot: ReviewSnapshot;
  private readonly orderedTargets: readonly InternalReviewCommentTarget[];
  private readonly targetsByAnchor: ReadonlyMap<
    string,
    InternalReviewCommentTarget
  >;
  private readonly commentsByAnchor = new Map<string, StoredComment>();

  constructor(snapshot: ReviewSnapshot, route: ReviewRoute) {
    this.snapshot = structuredClone(snapshot);
    const targets = buildCommentTargets(this.snapshot, route);
    this.orderedTargets = targets;
    this.targetsByAnchor = new Map(
      targets.map((target) => [commentAnchorKey(target), target]),
    );
  }

  get snapshotId(): SnapshotId {
    return this.snapshot.id;
  }

  listCommentableLines(): readonly ReviewCommentTarget[] {
    return this.orderedTargets.map(copyCommentTarget);
  }

  getComments(): readonly ReviewComment[] {
    return [...this.commentsByAnchor.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ comment }) => copyComment(comment));
  }

  getComment(anchor: ReviewCommentAnchor): ReviewComment | undefined {
    const stored = this.commentsByAnchor.get(commentAnchorKey(anchor));
    return stored === undefined ? undefined : copyComment(stored.comment);
  }

  upsertComment(input: ReviewCommentInput): ReviewComment {
    if (input.body.trim().length === 0) {
      throw new ReviewCommentInputError(
        "blank-comment-body",
        "Review comment body must not be blank.",
      );
    }

    const key = commentAnchorKey(input);
    const target = this.targetsByAnchor.get(key);
    if (target === undefined) {
      throw new ReviewSessionError(
        "unknown-comment-anchor",
        `Comment anchor does not match review unit ${input.reviewUnitId}, hunk ${input.hunkId}, line index ${input.diffLineIndex}.`,
      );
    }

    const comment = materializeComment(target, input.body);
    this.commentsByAnchor.set(key, { comment, order: target.order });
    return copyComment(comment);
  }

  deleteComment(anchor: ReviewCommentAnchor): { readonly deleted: boolean } {
    return { deleted: this.commentsByAnchor.delete(commentAnchorKey(anchor)) };
  }

  async submit(
    submissionMode: ReviewSubmissionMode,
    verifySnapshot: ReviewSnapshotVerifier,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SubmittedGuidedReviewResult> {
    signal.throwIfAborted();
    await verifySnapshot(structuredClone(this.snapshot), signal);
    signal.throwIfAborted();
    return {
      status: "submitted",
      snapshotId: this.snapshot.id,
      submissionMode,
      comments: this.getComments(),
    };
  }

  cancel(): CancelledGuidedReviewResult {
    return { status: "cancelled", snapshotId: this.snapshot.id };
  }
}

function buildCommentTargets(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): readonly InternalReviewCommentTarget[] {
  const hunksById = new Map(
    listSnapshotHunks(snapshot).map((hunk) => [hunk.id, hunk]),
  );
  const changesById = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );
  const targets: InternalReviewCommentTarget[] = [];

  for (const unit of route.units) {
    for (const hunkId of unit.hunkIds) {
      const hunk = hunksById.get(hunkId);
      assert.ok(
        hunk,
        `Validated review route references missing hunk ${hunkId}.`,
      );
      const change = changesById.get(hunk.fileChangeId);
      assert.ok(
        change,
        `Snapshot hunk ${hunk.id} references missing file change ${hunk.fileChangeId}.`,
      );

      for (const line of hunk.lines) {
        if (line.kind === "no-newline-marker") continue;
        const target: InternalReviewCommentTarget = {
          snapshotId: snapshot.id,
          reviewUnitId: unit.id,
          hunkId: hunk.id,
          diffLineIndex: line.index,
          filePath: commentFilePath(change, line),
          oldPath: change.oldPath,
          newPath: change.newPath,
          line: { ...line },
          hunkLines: hunk.lines,
          order: targets.length,
        };
        targets.push(target);
      }
    }
  }

  return targets;
}

function commentFilePath(change: FileChange, line: DiffLine): string {
  const filePath =
    line.kind === "removed"
      ? (change.oldPath ?? change.newPath)
      : (change.newPath ?? change.oldPath);
  assert.ok(filePath, `Text file change ${change.id} has no old or new path.`);
  return filePath;
}

function materializeComment(
  target: InternalReviewCommentTarget,
  body: string,
): ReviewComment {
  const contextStart = Math.max(
    0,
    target.diffLineIndex - REVIEW_COMMENT_CONTEXT_RADIUS,
  );
  const contextEnd = Math.min(
    target.hunkLines.length,
    target.diffLineIndex + REVIEW_COMMENT_CONTEXT_RADIUS + 1,
  );
  return {
    snapshotId: target.snapshotId,
    reviewUnitId: target.reviewUnitId,
    hunkId: target.hunkId,
    diffLineIndex: target.diffLineIndex,
    filePath: target.filePath,
    oldPath: target.oldPath,
    newPath: target.newPath,
    oldLine: target.line.oldLine,
    newLine: target.line.newLine,
    selectedDiffText: target.line.raw,
    nearbyDiffContext: target.hunkLines
      .slice(contextStart, contextEnd)
      .map((line) => ({ ...line })),
    body,
  };
}

function copyCommentTarget(
  target: InternalReviewCommentTarget,
): ReviewCommentTarget {
  return {
    snapshotId: target.snapshotId,
    reviewUnitId: target.reviewUnitId,
    hunkId: target.hunkId,
    diffLineIndex: target.diffLineIndex,
    filePath: target.filePath,
    oldPath: target.oldPath,
    newPath: target.newPath,
    line: { ...target.line },
  };
}

function copyComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    nearbyDiffContext: comment.nearbyDiffContext.map((line) => ({ ...line })),
  };
}

function commentAnchorKey(anchor: ReviewCommentAnchor): string {
  return JSON.stringify([
    anchor.reviewUnitId,
    anchor.hunkId,
    anchor.diffLineIndex,
  ]);
}
