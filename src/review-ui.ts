import type {
  CancelledGuidedReviewResult,
  DiffHunk,
  DiffLine,
  FileChangeId,
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

export interface ReviewDiffLineTarget extends ReviewCommentAnchor {
  readonly snapshotId: SnapshotId;
  readonly filePath: string;
  readonly line: DiffLine;
}

export class ReviewUiStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewUiStateError";
  }
}

interface SnapshotHunkEntry {
  readonly hunk: DiffHunk;
  readonly filePath: string;
}

interface InternalReviewDiffLineTarget extends ReviewDiffLineTarget {
  readonly hunkLines: readonly DiffLine[];
  readonly linePosition: number;
}

interface ReviewLineIndex {
  readonly snapshotId: SnapshotId;
  readonly orderedTargets: readonly InternalReviewDiffLineTarget[];
  readonly targetsByAnchor: ReadonlyMap<string, InternalReviewDiffLineTarget>;
  readonly orderByAnchor: ReadonlyMap<string, number>;
}

export function listReviewDiffLines(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): readonly ReviewDiffLineTarget[] {
  return buildReviewLineIndex(snapshot, route).orderedTargets.map((target) => ({
    snapshotId: target.snapshotId,
    reviewUnitId: target.reviewUnitId,
    hunkId: target.hunkId,
    diffLineIndex: target.diffLineIndex,
    filePath: target.filePath,
    line: { ...target.line },
  }));
}

export function upsertReviewComment(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  comments: readonly ReviewComment[],
  input: ReviewCommentInput,
): readonly ReviewComment[] {
  const index = buildReviewLineIndex(snapshot, route);
  const current = validateAndCopyComments(index, comments);
  const target = resolveTarget(index, input);
  const next = current.filter(
    (comment) => commentAnchorKey(comment) !== commentAnchorKey(input),
  );
  next.push(materializeComment(target, input.body));
  return sortComments(index, next);
}

export function deleteReviewComment(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  comments: readonly ReviewComment[],
  anchor: ReviewCommentAnchor,
): readonly ReviewComment[] {
  const index = buildReviewLineIndex(snapshot, route);
  const current = validateAndCopyComments(index, comments);
  resolveTarget(index, anchor);
  const deletedKey = commentAnchorKey(anchor);
  return current.filter((comment) => commentAnchorKey(comment) !== deletedKey);
}

export function createGuidedReviewSubmission(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  comments: readonly ReviewComment[],
  submissionMode: ReviewSubmissionMode,
): SubmittedGuidedReviewResult {
  validateSubmissionMode(submissionMode);
  const index = buildReviewLineIndex(snapshot, route);
  return {
    status: "submitted",
    snapshotId: snapshot.id,
    submissionMode,
    comments: validateAndCopyComments(index, comments),
  };
}

export function createGuidedReviewCancellation(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  comments: readonly ReviewComment[],
): CancelledGuidedReviewResult {
  const index = buildReviewLineIndex(snapshot, route);
  return {
    status: "cancelled",
    snapshotId: snapshot.id,
    comments: validateAndCopyComments(index, comments),
  };
}

function buildReviewLineIndex(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): ReviewLineIndex {
  if (route.snapshotId !== snapshot.id) {
    throw new ReviewUiStateError(
      `Review route references snapshot ${route.snapshotId}, not ${snapshot.id}.`,
    );
  }

  const hunksById = collectSnapshotHunks(snapshot);
  const referencedHunkIds = new Set<HunkId>();
  const unitIds = new Set<ReviewUnitId>();
  const orderedTargets: InternalReviewDiffLineTarget[] = [];
  const targetsByAnchor = new Map<string, InternalReviewDiffLineTarget>();
  const orderByAnchor = new Map<string, number>();

  for (const [unitIndex, unit] of route.units.entries()) {
    if (unitIds.has(unit.id)) {
      throw new ReviewUiStateError(
        `Review route contains duplicate review unit ID ${unit.id}.`,
      );
    }
    unitIds.add(unit.id);
    if (unit.hunkIds.length === 0) {
      throw new ReviewUiStateError(
        `Review unit ${unit.id} at position ${unitIndex + 1} contains no hunks.`,
      );
    }

    for (const hunkId of unit.hunkIds) {
      const entry = requireRouteHunk(
        hunksById,
        referencedHunkIds,
        hunkId,
        `review unit ${unit.id}`,
      );
      const lineIndexes = new Set<number>();
      for (const [linePosition, line] of entry.hunk.lines.entries()) {
        validateDiffLineIndex(line, entry.hunk.id, lineIndexes);
        const target: InternalReviewDiffLineTarget = {
          snapshotId: snapshot.id,
          reviewUnitId: unit.id,
          hunkId: entry.hunk.id,
          diffLineIndex: line.index,
          filePath: entry.filePath,
          line: { ...line },
          hunkLines: entry.hunk.lines,
          linePosition,
        };
        const key = commentAnchorKey(target);
        if (targetsByAnchor.has(key)) {
          throw new ReviewUiStateError(
            `Review route produces duplicate comment anchor for hunk ${entry.hunk.id} line index ${line.index}.`,
          );
        }
        orderByAnchor.set(key, orderedTargets.length);
        targetsByAnchor.set(key, target);
        orderedTargets.push(target);
      }
    }
  }

  for (const skipped of route.skippedHunks) {
    if (skipped.reason.trim().length === 0) {
      throw new ReviewUiStateError(
        `Skipped hunk ${skipped.hunkId} requires a non-empty reason.`,
      );
    }
    requireRouteHunk(
      hunksById,
      referencedHunkIds,
      skipped.hunkId,
      "skipped hunks",
    );
  }

  return {
    snapshotId: snapshot.id,
    orderedTargets,
    targetsByAnchor,
    orderByAnchor,
  };
}

function collectSnapshotHunks(
  snapshot: ReviewSnapshot,
): ReadonlyMap<HunkId, SnapshotHunkEntry> {
  const fileChangeIds = new Set<FileChangeId>();
  const hunksById = new Map<HunkId, SnapshotHunkEntry>();

  for (const change of snapshot.changes) {
    if (fileChangeIds.has(change.id)) {
      throw new ReviewUiStateError(
        `Snapshot ${snapshot.id} contains duplicate file change ID ${change.id}.`,
      );
    }
    fileChangeIds.add(change.id);
    if (change.content.kind !== "text") continue;

    const filePath = change.newPath ?? change.oldPath;
    if (filePath === undefined) {
      throw new ReviewUiStateError(
        `Text file change ${change.id} has no old or new path.`,
      );
    }
    for (const hunk of change.content.hunks) {
      if (hunk.fileChangeId !== change.id) {
        throw new ReviewUiStateError(
          `Hunk ${hunk.id} references file change ${hunk.fileChangeId}, but its parent is ${change.id}.`,
        );
      }
      if (hunksById.has(hunk.id)) {
        throw new ReviewUiStateError(
          `Snapshot ${snapshot.id} contains duplicate hunk ID ${hunk.id}.`,
        );
      }
      hunksById.set(hunk.id, { hunk, filePath });
    }
  }

  return hunksById;
}

function requireRouteHunk(
  hunksById: ReadonlyMap<HunkId, SnapshotHunkEntry>,
  referencedHunkIds: Set<HunkId>,
  hunkId: HunkId,
  location: string,
): SnapshotHunkEntry {
  const entry = hunksById.get(hunkId);
  if (entry === undefined) {
    throw new ReviewUiStateError(
      `Review route ${location} references unknown hunk ${hunkId}.`,
    );
  }
  if (referencedHunkIds.has(hunkId)) {
    throw new ReviewUiStateError(
      `Review route references hunk ${hunkId} more than once; duplicate appears in ${location}.`,
    );
  }
  referencedHunkIds.add(hunkId);
  return entry;
}

function validateDiffLineIndex(
  line: DiffLine,
  hunkId: HunkId,
  lineIndexes: Set<number>,
): void {
  if (!Number.isInteger(line.index) || line.index < 0) {
    throw new ReviewUiStateError(
      `Hunk ${hunkId} has invalid diff line index ${line.index}.`,
    );
  }
  if (lineIndexes.has(line.index)) {
    throw new ReviewUiStateError(
      `Hunk ${hunkId} contains duplicate diff line index ${line.index}.`,
    );
  }
  lineIndexes.add(line.index);
}

function resolveTarget(
  index: ReviewLineIndex,
  anchor: ReviewCommentAnchor,
): InternalReviewDiffLineTarget {
  if (!Number.isInteger(anchor.diffLineIndex) || anchor.diffLineIndex < 0) {
    throw new ReviewUiStateError(
      `Comment anchor has invalid diff line index ${anchor.diffLineIndex}.`,
    );
  }
  const target = index.targetsByAnchor.get(commentAnchorKey(anchor));
  if (target === undefined) {
    throw new ReviewUiStateError(
      `Comment anchor does not match review unit ${anchor.reviewUnitId}, hunk ${anchor.hunkId}, line index ${anchor.diffLineIndex}.`,
    );
  }
  return target;
}

function materializeComment(
  target: InternalReviewDiffLineTarget,
  body: string,
): ReviewComment {
  if (body.trim().length === 0) {
    throw new ReviewUiStateError("Review comment body must not be blank.");
  }
  const contextStart = Math.max(
    0,
    target.linePosition - REVIEW_COMMENT_CONTEXT_RADIUS,
  );
  const contextEnd = Math.min(
    target.hunkLines.length,
    target.linePosition + REVIEW_COMMENT_CONTEXT_RADIUS + 1,
  );
  return {
    snapshotId: target.snapshotId,
    reviewUnitId: target.reviewUnitId,
    hunkId: target.hunkId,
    diffLineIndex: target.diffLineIndex,
    filePath: target.filePath,
    oldLine: target.line.oldLine,
    newLine: target.line.newLine,
    selectedDiffText: target.line.raw,
    nearbyDiffContext: target.hunkLines
      .slice(contextStart, contextEnd)
      .map((line) => ({ ...line })),
    body,
  };
}

function validateAndCopyComments(
  index: ReviewLineIndex,
  comments: readonly ReviewComment[],
): ReviewComment[] {
  const seenAnchors = new Set<string>();
  const validated: ReviewComment[] = [];

  for (const comment of comments) {
    if (comment.snapshotId !== index.snapshotId) {
      throw new ReviewUiStateError(
        `Comment references snapshot ${comment.snapshotId}, not ${index.snapshotId}.`,
      );
    }
    const key = commentAnchorKey(comment);
    if (seenAnchors.has(key)) {
      throw new ReviewUiStateError(
        `Review comments contain duplicate anchor for hunk ${comment.hunkId} line index ${comment.diffLineIndex}.`,
      );
    }
    seenAnchors.add(key);
    const expected = materializeComment(
      resolveTarget(index, comment),
      comment.body,
    );
    assertCommentMatchesSnapshot(comment, expected);
    validated.push(expected);
  }

  return sortComments(index, validated);
}

function assertCommentMatchesSnapshot(
  comment: ReviewComment,
  expected: ReviewComment,
): void {
  if (
    comment.filePath !== expected.filePath ||
    comment.oldLine !== expected.oldLine ||
    comment.newLine !== expected.newLine ||
    comment.selectedDiffText !== expected.selectedDiffText ||
    !sameDiffLines(comment.nearbyDiffContext, expected.nearbyDiffContext)
  ) {
    throw new ReviewUiStateError(
      `Comment anchor for hunk ${comment.hunkId} line index ${comment.diffLineIndex} does not match the frozen snapshot.`,
    );
  }
}

function sameDiffLines(
  left: readonly DiffLine[],
  right: readonly DiffLine[],
): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        line.index === other.index &&
        line.kind === other.kind &&
        line.raw === other.raw &&
        line.oldLine === other.oldLine &&
        line.newLine === other.newLine
      );
    })
  );
}

function sortComments(
  index: ReviewLineIndex,
  comments: readonly ReviewComment[],
): ReviewComment[] {
  return [...comments].sort((left, right) => {
    const leftOrder = index.orderByAnchor.get(commentAnchorKey(left));
    const rightOrder = index.orderByAnchor.get(commentAnchorKey(right));
    if (leftOrder === undefined || rightOrder === undefined) {
      throw new ReviewUiStateError(
        "Cannot order a review comment with an unknown anchor.",
      );
    }
    return leftOrder - rightOrder;
  });
}

function validateSubmissionMode(mode: ReviewSubmissionMode): void {
  if (mode !== "discuss-first" && mode !== "apply-change-requests") {
    throw new ReviewUiStateError(
      `Unknown review submission mode ${JSON.stringify(mode)}.`,
    );
  }
}

function commentAnchorKey(anchor: ReviewCommentAnchor): string {
  return JSON.stringify([
    anchor.reviewUnitId,
    anchor.hunkId,
    anchor.diffLineIndex,
  ]);
}
