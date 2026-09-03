import {
  assertReviewDeltaMatchesSnapshot,
  isNeedsReviewReasonSkippable,
} from "./delta.ts";
import {
  type ChangedLine,
  changedLineKey,
  describeChangedLines,
  listFileChangedLines,
  resolvedSpanChangedLines,
} from "./span.ts";
import type {
  ChangedLineRecord,
  ChangedLineRef,
  ChangedLineRequirement,
  FileCoverage,
  ReviewCoverage,
  ReviewDelta,
  ReviewRoundId,
  ReviewRouteSkip,
  ReviewSnapshot,
} from "./types.ts";

export class ReviewCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCoverageError";
  }
}

export interface ReviewCoverageInput {
  readonly commentedLines: readonly ChangedLineRef[];
  readonly skippedSpans: readonly ReviewRouteSkip[];
}

export function computeReviewCoverage(
  roundId: ReviewRoundId,
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  input: ReviewCoverageInput,
): ReviewCoverage {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  const requirements = new Map(
    delta.lines.map((requirement) => [
      changedLineKey(requirement),
      requirement,
    ]),
  );
  const commented = collectCommentedLines(input.commentedLines, requirements);
  const skipped = collectSkippedLines(
    snapshot,
    input.skippedSpans,
    requirements,
  );

  for (const key of commented) {
    if (skipped.has(key)) {
      const line = skipped.get(key);
      throw new ReviewCoverageError(
        `${line === undefined ? key : describeLine(snapshot, line.line)} cannot be both commented and skipped.`,
      );
    }
  }

  const files: FileCoverage[] = [];
  for (const change of snapshot.changes) {
    const changedLines = listFileChangedLines(change);
    if (changedLines.length === 0) continue;
    files.push({
      oldPath: change.oldPath,
      newPath: change.newPath,
      lines: changedLines.map((line) =>
        buildRecord(roundId, line, requirements, commented, skipped),
      ),
    });
  }

  return { snapshotId: snapshot.id, files };
}

function buildRecord(
  roundId: ReviewRoundId,
  line: ChangedLine,
  requirements: ReadonlyMap<string, ChangedLineRequirement>,
  commented: ReadonlySet<string>,
  skipped: ReadonlyMap<
    string,
    { readonly line: ChangedLine; readonly reason: string }
  >,
): ChangedLineRecord {
  const key = changedLineKey(line);
  if (commented.has(key)) {
    return {
      side: line.side,
      line: line.line,
      text: line.text,
      disposition: "commented",
      commentedInRoundId: roundId,
    };
  }

  const skip = skipped.get(key);
  if (skip !== undefined) {
    return {
      side: line.side,
      line: line.line,
      text: line.text,
      disposition: "skipped",
      skippedInRoundId: roundId,
      skipReason: skip.reason,
    };
  }

  const requirement = requirements.get(key);
  if (requirement === undefined) {
    throw new ReviewCoverageError(
      `No review requirement exists for ${line.side} line ${line.line} of file change ${line.fileChangeId}.`,
    );
  }
  return {
    side: line.side,
    line: line.line,
    text: line.text,
    disposition: "reviewed-without-comment",
    reviewedInRoundId:
      requirement.type === "carried-forward"
        ? requirement.reviewedInRoundId
        : roundId,
  };
}

function collectCommentedLines(
  commentedLines: readonly ChangedLineRef[],
  requirements: ReadonlyMap<string, ChangedLineRequirement>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const ref of commentedLines) {
    const key = changedLineKey(ref);
    if (!requirements.has(key)) {
      throw new ReviewCoverageError(
        `Comment references ${ref.side} line ${ref.line} of file change ${ref.fileChangeId}, which is not a changed line in this snapshot.`,
      );
    }
    result.add(key);
  }
  return result;
}

function collectSkippedLines(
  snapshot: ReviewSnapshot,
  skippedSpans: readonly ReviewRouteSkip[],
  requirements: ReadonlyMap<string, ChangedLineRequirement>,
): ReadonlyMap<
  string,
  { readonly line: ChangedLine; readonly reason: string }
> {
  const result = new Map<
    string,
    { readonly line: ChangedLine; readonly reason: string }
  >();
  for (const skip of skippedSpans) {
    if (skip.reason.trim().length === 0) {
      throw new ReviewCoverageError(
        `Skipped span ${skip.span.path} requires a non-empty reason.`,
      );
    }
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      const key = changedLineKey(line);
      const requirement = requirements.get(key);
      if (requirement === undefined) {
        throw new ReviewCoverageError(
          `Skip references ${describeLine(snapshot, line)}, which has no review requirement.`,
        );
      }
      if (requirement.type === "carried-forward") {
        throw new ReviewCoverageError(
          `${describeLine(snapshot, line)} was carried forward and cannot be skipped.`,
        );
      }
      if (!isNeedsReviewReasonSkippable(requirement.reason)) {
        throw new ReviewCoverageError(
          `${describeLine(snapshot, line)} has an unresolved comment and cannot be skipped.`,
        );
      }
      if (result.has(key)) {
        throw new ReviewCoverageError(
          `${describeLine(snapshot, line)} is skipped more than once.`,
        );
      }
      result.set(key, { line, reason: skip.reason });
    }
  }
  return result;
}

function describeLine(snapshot: ReviewSnapshot, line: ChangedLine): string {
  return describeChangedLines(snapshot, [line])[0] ?? "A changed line";
}
