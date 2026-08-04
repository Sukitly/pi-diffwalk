import { Buffer } from "node:buffer";
import {
  listFileChangedLines,
  spanCoversLine,
  textContent,
} from "./review-span.ts";
import type { ChangeSide, FileChangeId, ReviewSnapshot } from "./types.ts";

/**
 * Conservative exact-move detection over the frozen snapshot.
 *
 * A detected move is evidence that a block of removed lines reappears,
 * byte-exact after indentation normalization, as a block of added lines
 * somewhere else in the change. The detection is deterministic and derived
 * only from snapshot content, so its output may be stated in the kickoff
 * inventory as coordinates. It never carries file content and it is never a
 * coverage rule: the agent is invited, not forced, to keep both sides of a
 * relocation in one review unit.
 *
 * The algorithm mirrors meat's move detector: a globally unique substantive
 * line anchors each candidate, extension requires exact normalized text and
 * one constant indentation offset, small candidates are dropped, and
 * overlapping candidates are discarded as ambiguous rather than guessed.
 */

/** A candidate must relocate at least this many lines containing code. */
export const MIN_MOVE_SUBSTANTIVE_LINES = 3;
/** A candidate must relocate at least this many non-whitespace bytes. */
export const MIN_MOVE_NONSPACE_BYTES = 48;

/** One side of a detected move: an inclusive changed-line range on one side of one file. */
export interface MoveSideRange {
  readonly fileChangeId: FileChangeId;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** An exact relocation: `removed` (old side) reappears as `added` (new side). */
export interface DetectedMove {
  readonly removed: MoveSideRange;
  readonly added: MoveSideRange;
}

interface MoveLineInfo {
  readonly normalized: string;
  readonly indent: number;
  readonly substantive: boolean;
  readonly nonspaceBytes: number;
  /** First and last line of the contiguous changed run containing this line. */
  readonly runStart: number;
  readonly runEnd: number;
  /** Index of the suggested span (Git hunk) containing this line, or -1. */
  readonly hunkIndex: number;
}

interface SideLines {
  readonly fileChangeId: FileChangeId;
  readonly fileIndex: number;
  readonly path: string;
  readonly side: ChangeSide;
  readonly lines: ReadonlyMap<number, MoveLineInfo>;
}

interface Occurrence {
  readonly side: SideLines;
  readonly line: number;
}

/**
 * Detects exact relocations between changed lines of the frozen snapshot.
 *
 * The result is deterministic for a given snapshot and sorted by removed
 * path and line, so it is safe to include in snapshot-derived artifacts.
 */
export function detectExactMoves(
  snapshot: ReviewSnapshot,
): readonly DetectedMove[] {
  const occurrences = new Map<string, Occurrence[]>();
  const sides: SideLines[] = [];

  for (const [fileIndex, change] of snapshot.changes.entries()) {
    const content = textContent(change);
    if (content === undefined) continue;
    const changed = listFileChangedLines(change);
    for (const side of ["old", "new"] as const) {
      const numbers = changed
        .filter((line) => line.side === side)
        .map((line) => line.line)
        .sort((left, right) => left - right);
      if (numbers.length === 0) continue;
      const texts = new Map(
        changed
          .filter((line) => line.side === side)
          .map((line) => [line.line, line.text]),
      );

      // Group the side's changed lines into maximal runs of consecutive
      // line numbers. Consecutive numbers mean physically adjacent lines on
      // that side, so a run is the analog of one contiguous +/- block.
      const runBounds = new Map<number, { start: number; end: number }>();
      let groupStart = 0;
      while (groupStart < numbers.length) {
        let groupEnd = groupStart;
        while (
          groupEnd + 1 < numbers.length &&
          numbers[groupEnd + 1] === (numbers[groupEnd] ?? 0) + 1
        ) {
          groupEnd += 1;
        }
        const bounds = {
          start: numbers[groupStart] ?? 0,
          end: numbers[groupEnd] ?? 0,
        };
        for (let index = groupStart; index <= groupEnd; index += 1) {
          runBounds.set(numbers[index] ?? 0, bounds);
        }
        groupStart = groupEnd + 1;
      }

      const infoByLine = new Map<number, MoveLineInfo>();
      for (const line of numbers) {
        const bounds = runBounds.get(line);
        const text = texts.get(line);
        if (bounds === undefined || text === undefined) continue;
        infoByLine.set(line, {
          ...normalizeMoveLine(text),
          runStart: bounds.start,
          runEnd: bounds.end,
          hunkIndex: content.suggestedSpans.findIndex((span) =>
            spanCoversLine(span, side, line),
          ),
        });
      }

      const path =
        side === "old"
          ? (change.oldPath ?? change.newPath ?? change.id)
          : (change.newPath ?? change.oldPath ?? change.id);
      const sideLines: SideLines = {
        fileChangeId: change.id,
        fileIndex,
        path,
        side,
        lines: infoByLine,
      };
      sides.push(sideLines);

      for (const [line, info] of infoByLine) {
        if (!info.substantive) continue;
        const list = occurrences.get(info.normalized) ?? [];
        list.push({ side: sideLines, line });
        occurrences.set(info.normalized, list);
      }
    }
  }

  const anchors: { removed: Occurrence; added: Occurrence }[] = [];
  for (const found of occurrences.values()) {
    if (found.length !== 2) continue;
    const removed = found.find((occurrence) => occurrence.side.side === "old");
    const added = found.find((occurrence) => occurrence.side.side === "new");
    if (removed === undefined || added === undefined) continue;
    anchors.push({ removed, added });
  }
  anchors.sort(
    (left, right) =>
      left.removed.side.fileIndex - right.removed.side.fileIndex ||
      left.removed.line - right.removed.line ||
      left.added.side.fileIndex - right.added.side.fileIndex ||
      left.added.line - right.added.line,
  );

  const candidateByKey = new Map<string, DetectedMove>();
  for (const anchor of anchors) {
    const removedInfo = anchor.removed.side.lines.get(anchor.removed.line);
    const addedInfo = anchor.added.side.lines.get(anchor.added.line);
    if (removedInfo === undefined || addedInfo === undefined) continue;
    if (anchor.removed.side.fileChangeId === anchor.added.side.fileChangeId) {
      // Inside one file, a pair within the same Git hunk is an edit, not a
      // relocation. An unknown hunk is treated conservatively the same way.
      if (
        removedInfo.hunkIndex < 0 ||
        removedInfo.hunkIndex === addedInfo.hunkIndex
      ) {
        continue;
      }
    }

    const indentOffset = addedInfo.indent - removedInfo.indent;
    let removedStart = anchor.removed.line;
    let removedEnd = anchor.removed.line;
    let addedStart = anchor.added.line;
    let addedEnd = anchor.added.line;
    while (
      removedStart > removedInfo.runStart &&
      addedStart > addedInfo.runStart &&
      moveRowsMatch(
        anchor.removed.side.lines.get(removedStart - 1),
        anchor.added.side.lines.get(addedStart - 1),
        indentOffset,
      )
    ) {
      removedStart -= 1;
      addedStart -= 1;
    }
    while (
      removedEnd < removedInfo.runEnd &&
      addedEnd < addedInfo.runEnd &&
      moveRowsMatch(
        anchor.removed.side.lines.get(removedEnd + 1),
        anchor.added.side.lines.get(addedEnd + 1),
        indentOffset,
      )
    ) {
      removedEnd += 1;
      addedEnd += 1;
    }

    if (!substantialMove(anchor.removed.side, removedStart, removedEnd)) {
      continue;
    }
    const candidate: DetectedMove = {
      removed: {
        fileChangeId: anchor.removed.side.fileChangeId,
        path: anchor.removed.side.path,
        start: removedStart,
        end: removedEnd,
      },
      added: {
        fileChangeId: anchor.added.side.fileChangeId,
        path: anchor.added.side.path,
        start: addedStart,
        end: addedEnd,
      },
    };
    candidateByKey.set(candidateKey(candidate), candidate);
  }

  const candidates = [...candidateByKey.values()];
  const ambiguous = candidates.map(() => false);
  for (const [i, left] of candidates.entries()) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const right = candidates[j];
      if (right === undefined) continue;
      if (
        rangesOverlap(left.removed, right.removed) ||
        rangesOverlap(left.added, right.added)
      ) {
        ambiguous[i] = true;
        ambiguous[j] = true;
      }
    }
  }

  return candidates
    .filter((_, index) => !ambiguous[index])
    .sort(
      (left, right) =>
        compareStrings(left.removed.path, right.removed.path) ||
        left.removed.start - right.removed.start ||
        compareStrings(left.added.path, right.added.path) ||
        left.added.start - right.added.start,
    );
}

function normalizeMoveLine(text: string): {
  normalized: string;
  indent: number;
  substantive: boolean;
  nonspaceBytes: number;
} {
  const trimmed = text.replace(/[ \t]+$/u, "");
  let index = 0;
  let indent = 0;
  while (index < trimmed.length) {
    const char = trimmed[index];
    if (char === " ") {
      indent += 1;
    } else if (char === "\t") {
      indent += 8 - (indent % 8);
    } else {
      break;
    }
    index += 1;
  }
  const normalized = trimmed.slice(index);
  return {
    normalized,
    indent,
    substantive: /[\p{L}\p{N}]/u.test(normalized),
    nonspaceBytes: Buffer.byteLength(normalized.replace(/\s+/gu, ""), "utf8"),
  };
}

function moveRowsMatch(
  removed: MoveLineInfo | undefined,
  added: MoveLineInfo | undefined,
  indentOffset: number,
): boolean {
  if (removed === undefined || added === undefined) return false;
  if (removed.normalized !== added.normalized) return false;
  if (removed.normalized === "") return true;
  return added.indent - removed.indent === indentOffset;
}

function substantialMove(side: SideLines, start: number, end: number): boolean {
  let substantiveLines = 0;
  let nonspaceBytes = 0;
  for (let line = start; line <= end; line += 1) {
    const info = side.lines.get(line);
    if (info === undefined) return false;
    if (info.substantive) substantiveLines += 1;
    nonspaceBytes += info.nonspaceBytes;
  }
  return (
    substantiveLines >= MIN_MOVE_SUBSTANTIVE_LINES &&
    nonspaceBytes >= MIN_MOVE_NONSPACE_BYTES
  );
}

function candidateKey(move: DetectedMove): string {
  return [
    move.removed.fileChangeId,
    move.removed.start,
    move.removed.end,
    move.added.fileChangeId,
    move.added.start,
    move.added.end,
  ].join("\u0000");
}

function rangesOverlap(left: MoveSideRange, right: MoveSideRange): boolean {
  return (
    left.fileChangeId === right.fileChangeId &&
    left.start <= right.end &&
    right.start <= left.end
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
