import {
  type ChangedLine,
  changedLineKey,
  listChangedLines,
  listFileChangedLines,
} from "./span.ts";
import type {
  ChangedLineRecord,
  ChangedLineRef,
  ChangedLineRequirement,
  ChangeSide,
  FileChange,
  FileCoverage,
  NeedsReviewReason,
  ReviewDelta,
  ReviewRound,
  ReviewSnapshot,
} from "./types.ts";

export class ReviewDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewDeltaError";
  }
}

/**
 * Beyond this many cells the quadratic alignment is replaced by occurrence
 * matching. Alignment quality only affects which unchanged lines are carried
 * forward, never coverage correctness.
 */
const MAX_ALIGNMENT_CELLS = 1_000_000;

export interface ComputeReviewDeltaOptions {
  readonly resolvedCommentLines?: readonly ChangedLineRef[];
}

export function computeReviewDelta(
  snapshot: ReviewSnapshot,
  baseline?: ReviewRound,
  options: ComputeReviewDeltaOptions = {},
): ReviewDelta {
  assertUniqueFileChanges(snapshot);
  const current = listChangedLines(snapshot);

  if (baseline === undefined) {
    return {
      currentSnapshotId: snapshot.id,
      lines: current.map((line) => ({
        type: "needs-review",
        fileChangeId: line.fileChangeId,
        side: line.side,
        line: line.line,
        reason: "new",
      })),
      removedLineCount: 0,
    };
  }

  assertBaselineRound(baseline);
  const baselineByPath = new Map<string, FileCoverage>();
  for (const file of baseline.coverage.files) {
    baselineByPath.set(fileKey(file.oldPath, file.newPath), file);
  }
  const resolvedComments = collectResolvedComments(
    baseline,
    options.resolvedCommentLines ?? [],
  );
  const baselineChangeByPath = new Map(
    baseline.snapshot.changes.map((change) => [
      coverageFileKey(change),
      change,
    ]),
  );

  const requirements = new Map<string, ChangedLineRequirement>();
  const consumedFiles = new Set<string>();
  let removedLineCount = 0;

  for (const change of snapshot.changes) {
    const changedLines = listFileChangedLines(change);
    if (changedLines.length === 0) continue;
    const key = coverageFileKey(change);
    const previous = baselineByPath.get(key);
    if (previous === undefined) {
      for (const line of changedLines) {
        requirements.set(changedLineKey(line), needsReview(line, "new"));
      }
      continue;
    }
    consumedFiles.add(key);
    const baselineChange = baselineChangeByPath.get(key);
    if (baselineChange === undefined) {
      throw new ReviewDeltaError(
        `Baseline round ${baseline.id} has coverage for ${key} without a matching snapshot change.`,
      );
    }
    removedLineCount += alignFile(
      changedLines,
      previous.lines,
      requirements,
      baselineChange.id,
      resolvedComments,
    );
  }

  for (const [key, file] of baselineByPath) {
    if (!consumedFiles.has(key)) removedLineCount += file.lines.length;
  }

  return {
    currentSnapshotId: snapshot.id,
    baselineRoundId: baseline.id,
    lines: current.map((line) => {
      const requirement = requirements.get(changedLineKey(line));
      if (requirement === undefined) {
        throw new ReviewDeltaError(
          `No review requirement was calculated for ${line.side} line ${line.line} of file change ${line.fileChangeId}.`,
        );
      }
      return requirement;
    }),
    removedLineCount,
  };
}

function collectResolvedComments(
  baseline: ReviewRound,
  refs: readonly ChangedLineRef[],
): ReadonlySet<string> {
  const changesById = new Map(
    baseline.snapshot.changes.map((change) => [change.id, change]),
  );
  const coverageByPath = new Map(
    baseline.coverage.files.map((file) => [
      fileKey(file.oldPath, file.newPath),
      file,
    ]),
  );
  const result = new Set<string>();

  for (const ref of refs) {
    const change = changesById.get(ref.fileChangeId);
    if (change === undefined) {
      throw new ReviewDeltaError(
        `Resolved comment references unknown file change ${ref.fileChangeId} in baseline round ${baseline.id}.`,
      );
    }
    const coverage = coverageByPath.get(coverageFileKey(change));
    const record = coverage?.lines.find(
      (line) => line.side === ref.side && line.line === ref.line,
    );
    if (record?.disposition !== "commented") {
      throw new ReviewDeltaError(
        `Resolved comment references ${ref.side} line ${ref.line} of file change ${ref.fileChangeId}, which is not commented in baseline round ${baseline.id}.`,
      );
    }
    result.add(changedLineKey(ref));
  }
  return result;
}

/** Returns the number of baseline lines that no longer exist in this file. */
function alignFile(
  current: readonly ChangedLine[],
  previous: readonly ChangedLineRecord[],
  requirements: Map<string, ChangedLineRequirement>,
  previousFileChangeId: FileChange["id"],
  resolvedComments: ReadonlySet<string>,
): number {
  const pairs = alignSequences(
    current.map((line) => lineKey(line.side, line.text)),
    previous.map((record) => lineKey(record.side, record.text)),
  );
  const matchedPrevious = new Set<number>();

  for (const [currentIndex, previousIndex] of pairs) {
    const line = current[currentIndex];
    const record = previous[previousIndex];
    if (line === undefined || record === undefined) continue;
    matchedPrevious.add(previousIndex);
    requirements.set(
      changedLineKey(line),
      fromRecord(
        line,
        record,
        resolvedComments.has(
          changedLineKey({
            fileChangeId: previousFileChangeId,
            side: record.side,
            line: record.line,
          }),
        ),
      ),
    );
  }

  for (const line of current) {
    const key = changedLineKey(line);
    if (!requirements.has(key)) {
      requirements.set(key, needsReview(line, "new"));
    }
  }

  return previous.length - matchedPrevious.size;
}

function fromRecord(
  line: ChangedLine,
  record: ChangedLineRecord,
  resolvedComment: boolean,
): ChangedLineRequirement {
  switch (record.disposition) {
    case "reviewed-without-comment":
      return {
        type: "carried-forward",
        fileChangeId: line.fileChangeId,
        side: line.side,
        line: line.line,
        reviewedInRoundId: record.reviewedInRoundId,
      };
    case "commented":
      return resolvedComment
        ? {
            type: "carried-forward",
            fileChangeId: line.fileChangeId,
            side: line.side,
            line: line.line,
            reviewedInRoundId: record.commentedInRoundId,
          }
        : needsReview(line, "unresolved-comment");
    case "skipped":
      return needsReview(line, "previously-skipped");
  }
}

function needsReview(
  line: ChangedLine,
  reason: NeedsReviewReason,
): ChangedLineRequirement {
  return {
    type: "needs-review",
    fileChangeId: line.fileChangeId,
    side: line.side,
    line: line.line,
    reason,
  };
}

/**
 * Longest common subsequence over changed-line keys, after stripping the common
 * prefix and suffix. Returns index pairs of aligned entries.
 */
export function alignSequences(
  left: readonly string[],
  right: readonly string[],
): readonly (readonly [number, number])[] {
  const pairs: [number, number][] = [];
  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  ) {
    pairs.push([start, start]);
    start += 1;
  }

  let leftEnd = left.length - 1;
  let rightEnd = right.length - 1;
  const tail: [number, number][] = [];
  while (
    leftEnd >= start &&
    rightEnd >= start &&
    left[leftEnd] === right[rightEnd]
  ) {
    tail.push([leftEnd, rightEnd]);
    leftEnd -= 1;
    rightEnd -= 1;
  }

  const leftMiddle = left.slice(start, leftEnd + 1);
  const rightMiddle = right.slice(start, rightEnd + 1);
  const middle =
    leftMiddle.length * rightMiddle.length > MAX_ALIGNMENT_CELLS
      ? matchByOccurrence(leftMiddle, rightMiddle)
      : longestCommonSubsequence(leftMiddle, rightMiddle);
  for (const [leftIndex, rightIndex] of middle) {
    pairs.push([leftIndex + start, rightIndex + start]);
  }

  pairs.push(...tail.reverse());
  return pairs;
}

function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[],
): readonly (readonly [number, number])[] {
  if (left.length === 0 || right.length === 0) return [];
  const width = right.length + 1;
  const table = new Int32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }

  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function matchByOccurrence(
  left: readonly string[],
  right: readonly string[],
): readonly (readonly [number, number])[] {
  const rightIndexes = new Map<string, number[]>();
  for (const [index, key] of right.entries()) {
    const list = rightIndexes.get(key) ?? [];
    list.push(index);
    rightIndexes.set(key, list);
  }
  const cursors = new Map<string, number>();
  const pairs: [number, number][] = [];
  let lastRight = -1;
  for (const [leftIndex, key] of left.entries()) {
    const candidates = rightIndexes.get(key);
    if (candidates === undefined) continue;
    let cursor = cursors.get(key) ?? 0;
    while (
      cursor < candidates.length &&
      (candidates[cursor] ?? -1) <= lastRight
    ) {
      cursor += 1;
    }
    const rightIndex = candidates[cursor];
    if (rightIndex === undefined) continue;
    cursors.set(key, cursor + 1);
    lastRight = rightIndex;
    pairs.push([leftIndex, rightIndex]);
  }
  return pairs;
}

export function assertReviewDeltaMatchesSnapshot(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
): void {
  if (delta.currentSnapshotId !== snapshot.id) {
    throw new ReviewDeltaError(
      `Review delta references snapshot ${delta.currentSnapshotId}, not ${snapshot.id}.`,
    );
  }

  const expected = new Set(
    listChangedLines(snapshot).map((line) => changedLineKey(line)),
  );
  const seen = new Set<string>();
  for (const requirement of delta.lines) {
    const key = changedLineKey(requirement);
    if (!expected.has(key)) {
      throw new ReviewDeltaError(
        `Review delta contains ${requirement.side} line ${requirement.line} of file change ${requirement.fileChangeId}, which is not a changed line in this snapshot.`,
      );
    }
    if (seen.has(key)) {
      throw new ReviewDeltaError(
        `Review delta contains duplicate ${requirement.side} line ${requirement.line} of file change ${requirement.fileChangeId}.`,
      );
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw new ReviewDeltaError(
      `Review delta covers ${seen.size} changed lines, but snapshot ${snapshot.id} has ${expected.size}.`,
    );
  }
}

export function isNeedsReviewReasonSkippable(
  reason: NeedsReviewReason,
): boolean {
  switch (reason) {
    case "unresolved-comment":
      return false;
    case "new":
    case "previously-skipped":
      return true;
  }
}

function assertUniqueFileChanges(snapshot: ReviewSnapshot): void {
  const seen = new Set<string>();
  for (const change of snapshot.changes) {
    if (seen.has(change.id)) {
      throw new ReviewDeltaError(
        `Snapshot ${snapshot.id} contains duplicate file change ID ${change.id}.`,
      );
    }
    seen.add(change.id);
  }
}

function assertBaselineRound(baseline: ReviewRound): void {
  if (baseline.delta.currentSnapshotId !== baseline.snapshot.id) {
    throw new ReviewDeltaError(
      `Baseline round ${baseline.id} delta references snapshot ${baseline.delta.currentSnapshotId}, not ${baseline.snapshot.id}.`,
    );
  }
  if (baseline.coverage.snapshotId !== baseline.snapshot.id) {
    throw new ReviewDeltaError(
      `Baseline round ${baseline.id} coverage references snapshot ${baseline.coverage.snapshotId}, not ${baseline.snapshot.id}.`,
    );
  }
  const seen = new Set<string>();
  for (const file of baseline.coverage.files) {
    const key = fileKey(file.oldPath, file.newPath);
    if (seen.has(key)) {
      throw new ReviewDeltaError(
        `Baseline round ${baseline.id} contains duplicate coverage for ${key}.`,
      );
    }
    seen.add(key);
  }
}

export function fileKey(
  oldPath: string | undefined,
  newPath: string | undefined,
): string {
  return JSON.stringify([oldPath ?? null, newPath ?? null]);
}

export function coverageFileKey(change: FileChange): string {
  return fileKey(change.oldPath, change.newPath);
}

function lineKey(side: ChangeSide, text: string): string {
  return `${side}\u0000${text}`;
}
