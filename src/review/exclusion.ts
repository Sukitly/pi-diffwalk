import { type ChangedLine, changedLineKey, textContent } from "./span.ts";
import type {
  ChangeSide,
  DiffLine,
  ExclusionReason,
  FileChange,
  ReviewSnapshot,
} from "./types.ts";

/**
 * Mechanical exclusion: changed lines that a rule, not a judgment, removes
 * from the review.
 *
 * Every rule here is deterministic over the frozen snapshot plus facts that
 * Git reports about paths. No rule reads the meaning of the code. Anything
 * that requires judgment stays with the agent's `skippedSpans` and the
 * reviewer's eyes.
 */

export interface ExclusionMark {
  readonly reason: ExclusionReason;
  readonly pattern?: string;
}

/** Facts about paths that only Git can answer, resolved before exclusion runs. */
export interface PathExclusionFacts {
  /** Path to the DiffWalk exclude pattern that matched it. */
  readonly excludedPaths: ReadonlyMap<string, string>;
  /** Paths whose `linguist-generated` attribute is set. */
  readonly generatedPaths: ReadonlySet<string>;
}

export const EMPTY_PATH_EXCLUSION_FACTS: PathExclusionFacts = {
  excludedPaths: new Map(),
  generatedPaths: new Set(),
};

/** Human-readable rule name, used wherever an exclusion is shown. */
export function describeExclusion(mark: ExclusionMark): string {
  switch (mark.reason) {
    case "excluded-path":
      return mark.pattern === undefined
        ? "matches a DiffWalk exclude pattern"
        : `matches exclude pattern ${JSON.stringify(mark.pattern)}`;
    case "generated-attribute":
      return "marked linguist-generated in Git attributes";
    case "whitespace-only":
      return "whitespace-only change";
  }
}

/**
 * The path Git rules apply to. A rename is judged by where the file ends up;
 * a deletion by where it was.
 */
export function exclusionPath(change: FileChange): string | undefined {
  return change.newPath ?? change.oldPath;
}

/** Changed-line key to the exclusion that removes it, for the whole snapshot. */
export function computeExclusions(
  snapshot: ReviewSnapshot,
  facts: PathExclusionFacts,
): ReadonlyMap<string, ExclusionMark> {
  const marks = new Map<string, ExclusionMark>();
  for (const change of snapshot.changes) {
    const content = textContent(change);
    if (content === undefined) continue;
    const path = exclusionPath(change);
    const fileMark =
      path === undefined ? undefined : fileExclusion(path, facts);
    if (fileMark !== undefined) {
      for (const line of changedLinesOf(change, content.lines)) {
        marks.set(changedLineKey(line), fileMark);
      }
      continue;
    }
    for (const line of whitespaceOnlyLines(change, content.lines)) {
      marks.set(changedLineKey(line), { reason: "whitespace-only" });
    }
  }
  return marks;
}

function fileExclusion(
  path: string,
  facts: PathExclusionFacts,
): ExclusionMark | undefined {
  const pattern = facts.excludedPaths.get(path);
  if (pattern !== undefined) return { reason: "excluded-path", pattern };
  if (facts.generatedPaths.has(path)) return { reason: "generated-attribute" };
  return undefined;
}

/**
 * Changed lines in runs whose removed and added text differ only in
 * whitespace that cannot change meaning.
 *
 * A run is a maximal sequence of consecutive changed lines. Within a run the
 * removed lines and the added lines must match one-to-one after dropping
 * blank lines and removing every non-leading whitespace character, which is
 * what `git diff -w` hides. Leading whitespace must match exactly:
 * indentation carries meaning in some languages, so a reindented block
 * always reaches the reviewer.
 */
export function whitespaceOnlyLines(
  change: FileChange,
  lines: readonly DiffLine[],
): readonly ChangedLine[] {
  const result: ChangedLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type === "context") {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index]?.type !== "context") {
      index += 1;
    }
    const run = lines.slice(start, index);
    if (isWhitespaceOnlyRun(run)) {
      result.push(...changedLinesOf(change, run));
    }
  }
  return result;
}

function isWhitespaceOnlyRun(run: readonly DiffLine[]): boolean {
  const removed = normalizedTexts(run, "removed");
  const added = normalizedTexts(run, "added");
  if (removed.length !== added.length) return false;
  return removed.every((text, position) => text === added[position]);
}

function normalizedTexts(
  run: readonly DiffLine[],
  type: "removed" | "added",
): readonly string[] {
  const texts: string[] = [];
  for (const line of run) {
    if (line.type !== type) continue;
    const normalized = normalizeWhitespace(line.text);
    if (normalized.length > 0) texts.push(normalized);
  }
  return texts;
}

function normalizeWhitespace(text: string): string {
  const leading = /^\s*/.exec(text)?.[0] ?? "";
  const body = text.slice(leading.length).replace(/\s+/g, "");
  return body.length === 0 ? "" : `${leading}${body}`;
}

function changedLinesOf(
  change: FileChange,
  lines: readonly DiffLine[],
): readonly ChangedLine[] {
  const result: ChangedLine[] = [];
  for (const line of lines) {
    if (line.type === "context") continue;
    const side: ChangeSide = line.type === "added" ? "new" : "old";
    const number = side === "new" ? line.newLine : line.oldLine;
    if (number === undefined) continue;
    result.push({
      fileChangeId: change.id,
      side,
      line: number,
      text: line.text,
    });
  }
  return result;
}
