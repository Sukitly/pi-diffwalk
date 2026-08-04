import type {
  ChangedLineRef,
  ChangeSide,
  FileChange,
  ResolvedSpan,
  ReviewSnapshot,
  ReviewSpan,
  TextChange,
} from "./types.ts";

export class ReviewSpanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSpanError";
  }
}

export interface ChangedLine extends ChangedLineRef {
  readonly text: string;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export type SpanIssueCode =
  | "unknown-path"
  | "non-text-file"
  | "missing-range"
  | "incomplete-range"
  | "inverted-range"
  | "out-of-range"
  | "no-changed-lines";

export interface SpanIssue {
  readonly code: SpanIssueCode;
  readonly message: string;
}

export interface ResolveSpanResult {
  readonly span?: ResolvedSpan;
  readonly issues: readonly SpanIssue[];
}

/** Stable key for one changed line, usable in Set and Map. */
export function changedLineKey(ref: ChangedLineRef): string {
  return `${ref.fileChangeId}\u0000${ref.side}\u0000${ref.line}`;
}

export function textContent(change: FileChange): TextChange | undefined {
  return change.content.type === "text" ? change.content : undefined;
}

export function listFileChangedLines(
  change: FileChange,
): readonly ChangedLine[] {
  const content = textContent(change);
  if (content === undefined) return [];
  const lines: ChangedLine[] = [];
  for (const line of content.lines) {
    if (line.type === "context") continue;
    const side: ChangeSide = line.type === "added" ? "new" : "old";
    const number = line.type === "added" ? line.newLine : line.oldLine;
    if (number === undefined) {
      throw new ReviewSpanError(
        `File change ${change.id} has an ${line.type} line without a ${side} line number.`,
      );
    }
    lines.push({
      fileChangeId: change.id,
      side,
      line: number,
      text: line.text,
    });
  }
  return lines;
}

export function listChangedLines(
  snapshot: ReviewSnapshot,
): readonly ChangedLine[] {
  return snapshot.changes.flatMap((change) => listFileChangedLines(change));
}

/** Contiguous changed-line ranges per side, used to describe a file compactly. */
export function summarizeChangedRanges(change: FileChange): {
  readonly old: readonly LineRange[];
  readonly new: readonly LineRange[];
} {
  const old: LineRange[] = [];
  const next: LineRange[] = [];
  for (const line of listFileChangedLines(change)) {
    const target = line.side === "old" ? old : next;
    const last = target.at(-1);
    if (last !== undefined && last.end === line.line - 1) {
      target[target.length - 1] = { start: last.start, end: line.line };
      continue;
    }
    target.push({ start: line.line, end: line.line });
  }
  return { old, new: next };
}

export function findChangeByPath(
  snapshot: ReviewSnapshot,
  path: string,
): FileChange | undefined {
  return (
    snapshot.changes.find((change) => change.newPath === path) ??
    snapshot.changes.find((change) => change.oldPath === path)
  );
}

export function resolveSpan(
  snapshot: ReviewSnapshot,
  candidate: ReviewSpan,
  location: string,
): ResolveSpanResult {
  const issues: SpanIssue[] = [];
  const change = findChangeByPath(snapshot, candidate.path);
  if (change === undefined) {
    return {
      issues: [
        {
          code: "unknown-path",
          message: `${location} references ${JSON.stringify(candidate.path)}, which is not a changed file in this snapshot.`,
        },
      ],
    };
  }

  if (change.content.type !== "text") {
    return {
      issues: [
        {
          code: "non-text-file",
          message: `${location} references ${JSON.stringify(candidate.path)}, which has no reviewable text content: ${change.content.unsupportedReason}`,
        },
      ],
    };
  }
  const content = change.content;

  const hasOld =
    candidate.oldStart !== undefined || candidate.oldEnd !== undefined;
  const hasNew =
    candidate.newStart !== undefined || candidate.newEnd !== undefined;
  if (!hasOld && !hasNew) {
    issues.push({
      code: "missing-range",
      message: `${location} must set an old or a new line range.`,
    });
  }
  validateSide(
    "old",
    candidate.oldStart,
    candidate.oldEnd,
    content.oldLineCount,
    location,
    issues,
  );
  validateSide(
    "new",
    candidate.newStart,
    candidate.newEnd,
    content.newLineCount,
    location,
    issues,
  );
  if (issues.length > 0) return { issues };

  const span: ResolvedSpan = {
    fileChangeId: change.id,
    path: candidate.path,
    ...(candidate.oldStart === undefined
      ? {}
      : { oldStart: candidate.oldStart, oldEnd: candidate.oldEnd }),
    ...(candidate.newStart === undefined
      ? {}
      : { newStart: candidate.newStart, newEnd: candidate.newEnd }),
  };

  if (spanChangedLines(change, span).length === 0) {
    return {
      issues: [
        {
          code: "no-changed-lines",
          message: `${location} covers no changed line. Reference a region that contains added or removed lines.`,
        },
      ],
    };
  }

  return { span, issues: [] };
}

function validateSide(
  side: ChangeSide,
  start: number | undefined,
  end: number | undefined,
  lineCount: number,
  location: string,
  issues: SpanIssue[],
): void {
  if (start === undefined && end === undefined) return;
  if (start === undefined || end === undefined) {
    issues.push({
      code: "incomplete-range",
      message: `${location} must set both ${side}Start and ${side}End.`,
    });
    return;
  }
  if (start > end) {
    issues.push({
      code: "inverted-range",
      message: `${location} has ${side}Start ${start} after ${side}End ${end}.`,
    });
    return;
  }
  if (lineCount === 0) {
    issues.push({
      code: "out-of-range",
      message: `${location} references the ${side} side of a file that has no ${side} content.`,
    });
    return;
  }
  if (end > lineCount) {
    issues.push({
      code: "out-of-range",
      message: `${location} references ${side} line ${end}, but the frozen file has ${lineCount} lines on that side.`,
    });
  }
}

export function spanCoversLine(
  span: ReviewSpan,
  side: ChangeSide,
  line: number,
): boolean {
  const start = side === "old" ? span.oldStart : span.newStart;
  const end = side === "old" ? span.oldEnd : span.newEnd;
  if (start === undefined || end === undefined) return false;
  return line >= start && line <= end;
}

export function spanChangedLines(
  change: FileChange,
  span: ReviewSpan,
): readonly ChangedLine[] {
  return listFileChangedLines(change).filter((line) =>
    spanCoversLine(span, line.side, line.line),
  );
}

export function resolvedSpanChangedLines(
  snapshot: ReviewSnapshot,
  span: ResolvedSpan,
): readonly ChangedLine[] {
  const change = snapshot.changes.find(
    (candidate) => candidate.id === span.fileChangeId,
  );
  if (change === undefined) {
    throw new ReviewSpanError(
      `Span references file change ${span.fileChangeId}, which is not in snapshot ${snapshot.id}.`,
    );
  }
  return spanChangedLines(change, span);
}

export interface SpanCoverageInput {
  /** Spans of each review unit, in route order. */
  readonly unitSpans: readonly (readonly ResolvedSpan[])[];
  readonly skippedSpans: readonly ResolvedSpan[];
}

export interface DuplicateCoverage {
  readonly line: ChangedLine;
  readonly unitIndexes: readonly number[];
}

export interface SpanCoverageResult {
  readonly coveredByUnit: readonly (readonly ChangedLine[])[];
  readonly skipped: readonly ChangedLine[];
  readonly uncovered: readonly ChangedLine[];
  readonly duplicated: readonly DuplicateCoverage[];
  /** Lines that are both covered by a unit and explicitly skipped. */
  readonly conflicting: readonly ChangedLine[];
}

export function computeSpanCoverage(
  snapshot: ReviewSnapshot,
  input: SpanCoverageInput,
): SpanCoverageResult {
  const universe = listChangedLines(snapshot);
  const unitIndexesByKey = new Map<string, number[]>();
  const coveredByUnit: ChangedLine[][] = [];

  for (const [unitIndex, spans] of input.unitSpans.entries()) {
    const seen = new Map<string, ChangedLine>();
    for (const span of spans) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        seen.set(changedLineKey(line), line);
      }
    }
    coveredByUnit.push([...seen.values()]);
    for (const key of seen.keys()) {
      const indexes = unitIndexesByKey.get(key) ?? [];
      if (!indexes.includes(unitIndex)) indexes.push(unitIndex);
      unitIndexesByKey.set(key, indexes);
    }
  }

  const skippedKeys = new Map<string, ChangedLine>();
  for (const span of input.skippedSpans) {
    for (const line of resolvedSpanChangedLines(snapshot, span)) {
      skippedKeys.set(changedLineKey(line), line);
    }
  }

  const uncovered: ChangedLine[] = [];
  const duplicated: DuplicateCoverage[] = [];
  const conflicting: ChangedLine[] = [];
  for (const line of universe) {
    const key = changedLineKey(line);
    const indexes = unitIndexesByKey.get(key) ?? [];
    const isSkipped = skippedKeys.has(key);
    if (indexes.length > 1) {
      duplicated.push({ line, unitIndexes: indexes });
    }
    if (indexes.length > 0 && isSkipped) {
      conflicting.push(line);
    }
    if (indexes.length === 0 && !isSkipped) {
      uncovered.push(line);
    }
  }

  return {
    coveredByUnit,
    skipped: [...skippedKeys.values()],
    uncovered,
    duplicated,
    conflicting,
  };
}

/** Human-readable location for error messages, for example `src/a.ts new 12-18`. */
export function describeSpan(span: ReviewSpan): string {
  const parts: string[] = [];
  if (span.oldStart !== undefined && span.oldEnd !== undefined) {
    parts.push(`old ${span.oldStart}-${span.oldEnd}`);
  }
  if (span.newStart !== undefined && span.newEnd !== undefined) {
    parts.push(`new ${span.newStart}-${span.newEnd}`);
  }
  return `${span.path} ${parts.join(" ")}`.trim();
}

/** Groups changed lines into compact per-file, per-side ranges for reporting. */
export function describeChangedLines(
  snapshot: ReviewSnapshot,
  lines: readonly ChangedLine[],
): readonly string[] {
  const byFile = new Map<string, ChangedLine[]>();
  for (const line of lines) {
    const group = byFile.get(line.fileChangeId) ?? [];
    group.push(line);
    byFile.set(line.fileChangeId, group);
  }

  const descriptions: string[] = [];
  for (const [fileChangeId, group] of byFile) {
    const change = snapshot.changes.find(
      (candidate) => candidate.id === fileChangeId,
    );
    const path = change?.newPath ?? change?.oldPath ?? fileChangeId;
    for (const side of ["old", "new"] as const) {
      const numbers = group
        .filter((line) => line.side === side)
        .map((line) => line.line)
        .sort((left, right) => left - right);
      for (const range of toRanges(numbers)) {
        descriptions.push(`${path} ${side} ${range.start}-${range.end}`);
      }
    }
  }
  return descriptions;
}

function toRanges(numbers: readonly number[]): readonly LineRange[] {
  const ranges: LineRange[] = [];
  for (const value of numbers) {
    const last = ranges.at(-1);
    if (last !== undefined && last.end === value - 1) {
      ranges[ranges.length - 1] = { start: last.start, end: value };
      continue;
    }
    ranges.push({ start: value, end: value });
  }
  return ranges;
}
