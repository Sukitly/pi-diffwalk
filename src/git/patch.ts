import type {
  BinaryChange,
  FileChangeSource,
  FileChangeStatus,
  MetadataOnlyChange,
  UnsupportedChange,
} from "../review/types.ts";
import { GitSnapshotError } from "./errors.ts";
import { requiredAt, splitLines } from "./runner.ts";

export interface RawFileChange {
  readonly statusCode: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly oldPath?: string;
  readonly newPath?: string;
}

export interface UntrackedFile {
  readonly path: string;
  readonly patch: string;
}

/** Unified diff hunk header. Hunks are an internal parsing artifact only. */
interface HunkHeader {
  readonly raw: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

type ParsedLineType = "context" | "added" | "removed" | "no-newline-marker";

interface ParsedLine {
  readonly type: ParsedLineType;
  readonly raw: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface HunkDraft {
  readonly header: HunkHeader;
  readonly lines: readonly ParsedLine[];
}

type ContentDraft =
  | {
      readonly type: "text";
      readonly hunks: readonly HunkDraft[];
    }
  | BinaryChange
  | MetadataOnlyChange
  | UnsupportedChange;

interface PatchDraft {
  readonly gitHeaderLines: readonly string[];
  readonly content: ContentDraft;
}

export interface FileChangeDraft {
  readonly source: FileChangeSource;
  readonly status: FileChangeStatus;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly gitHeaderLines: readonly string[];
  readonly content: ContentDraft;
}

export function parseRawDiff(output: string): readonly RawFileChange[] {
  if (output.length === 0) return [];

  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: RawFileChange[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = requiredAt(fields, index, "raw diff header");
    index += 1;
    const match =
      /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    if (!match) {
      throw new GitSnapshotError(
        `Unable to parse Git raw diff header ${JSON.stringify(header)}.`,
      );
    }

    const oldModeValue = requiredAt(match, 1, "raw diff old mode");
    const newModeValue = requiredAt(match, 2, "raw diff new mode");
    const statusCode = requiredAt(match, 3, "raw diff status");
    const firstPath = requiredAt(fields, index, "raw diff path");
    index += 1;

    if (statusCode === "R" || statusCode === "C") {
      const secondPath = requiredAt(fields, index, "raw diff destination path");
      index += 1;
      changes.push({
        statusCode,
        oldMode: normalizeMode(oldModeValue),
        newMode: normalizeMode(newModeValue),
        oldPath: firstPath,
        newPath: secondPath,
      });
      continue;
    }

    changes.push({
      statusCode,
      oldMode: normalizeMode(oldModeValue),
      newMode: normalizeMode(newModeValue),
      oldPath: statusCode === "A" ? undefined : firstPath,
      newPath: statusCode === "D" ? undefined : firstPath,
    });
  }

  return changes;
}

function normalizeMode(mode: string): string | undefined {
  return mode === "000000" ? undefined : mode;
}

export function splitPatchBlocks(
  output: string,
): readonly (readonly string[])[] {
  if (output.length === 0) return [];
  const lines = splitLines(output);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (requiredAt(lines, index, "patch line").startsWith("diff --git "))
      starts.push(index);
  }
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length),
  );
}

export function buildTrackedDrafts(
  records: readonly RawFileChange[],
  blocks: readonly (readonly string[])[],
  unmergedPaths: ReadonlySet<string>,
): readonly FileChangeDraft[] {
  const blockGroups = groupPatchBlocksByHeader(blocks);
  if (records.length !== blockGroups.length) {
    const reason = `Git reported ${records.length} file changes but produced ${blockGroups.length} distinct patch block groups. DiffWalk cannot match the patch blocks safely.`;
    return records.map((record) =>
      buildUnsupportedDraft(record, "tracked", reason),
    );
  }

  return records.map((record, index) => {
    const effectiveRecord = recordTouchesPaths(record, unmergedPaths)
      ? { ...record, statusCode: "U" }
      : record;
    return buildDraft(
      effectiveRecord,
      "tracked",
      parsePatchBlocks(
        requiredAt(blockGroups, index, "tracked patch block group"),
      ),
    );
  });
}

function groupPatchBlocksByHeader(
  blocks: readonly (readonly string[])[],
): readonly (readonly (readonly string[])[])[] {
  const groups: (readonly string[])[][] = [];
  for (const block of blocks) {
    const header = requiredAt(block, 0, "patch block header");
    const previous = groups.at(-1);
    if (
      previous !== undefined &&
      requiredAt(previous.at(-1) ?? [], 0, "patch block header") === header
    ) {
      previous.push(block);
    } else {
      groups.push([block]);
    }
  }
  return groups;
}

function parsePatchBlocks(blocks: readonly (readonly string[])[]): PatchDraft {
  const drafts = blocks.map(parsePatchBlock);
  if (drafts.length === 1) return requiredAt(drafts, 0, "parsed patch block");

  const gitHeaderLines = drafts.flatMap((draft) => draft.gitHeaderLines);
  if (drafts.every((draft) => draft.content.type === "text")) {
    return {
      gitHeaderLines,
      content: {
        type: "text",
        hunks: drafts.flatMap((draft) =>
          draft.content.type === "text" ? draft.content.hunks : [],
        ),
      },
    };
  }

  return {
    gitHeaderLines,
    content: {
      type: "unsupported",
      gitBodyLines: drafts.flatMap((draft) => contentBodyLines(draft.content)),
      unsupportedReason:
        "This file type change contains incompatible patch formats.",
    },
  };
}

export function buildUntrackedDraft(file: UntrackedFile): FileChangeDraft {
  const blocks = splitPatchBlocks(file.patch);
  if (blocks.length !== 1) {
    return buildUnsupportedDraft(
      {
        statusCode: "A",
        newPath: file.path,
      },
      "untracked",
      `Git produced ${blocks.length} patch blocks for one untracked file.`,
    );
  }

  const patch = parsePatchBlock(requiredAt(blocks, 0, "untracked patch block"));
  const newMode = patch.gitHeaderLines
    .map((line) => /^new file mode ([0-7]{6})$/.exec(line)?.[1])
    .find((mode) => mode !== undefined);
  return buildDraft(
    {
      statusCode: "A",
      newMode,
      newPath: file.path,
    },
    "untracked",
    patch,
  );
}

function buildUnsupportedDraft(
  record: RawFileChange,
  source: FileChangeSource,
  reason: string,
): FileChangeDraft {
  return buildDraft(record, source, {
    gitHeaderLines: [],
    content: {
      type: "unsupported",
      gitBodyLines: [],
      unsupportedReason: reason,
    },
  });
}

function buildDraft(
  record: RawFileChange,
  source: FileChangeSource,
  patch: PatchDraft,
): FileChangeDraft {
  let content = patch.content;
  if (record.statusCode === "U" || record.statusCode === "X") {
    content = {
      type: "unsupported",
      gitBodyLines: contentBodyLines(patch.content),
      unsupportedReason:
        record.statusCode === "U"
          ? "Unmerged Git changes are not supported."
          : "Git reported an unknown file change status.",
    };
  } else if (record.oldMode === "160000" || record.newMode === "160000") {
    content = {
      type: "unsupported",
      gitBodyLines: contentBodyLines(patch.content),
      unsupportedReason: "Gitlink changes are not supported.",
    };
  }

  return {
    source,
    status: mapFileStatus(record, content),
    oldPath: record.oldPath,
    newPath: record.newPath,
    oldMode: record.oldMode,
    newMode: record.newMode,
    gitHeaderLines: patch.gitHeaderLines,
    content,
  };
}

function mapFileStatus(
  record: RawFileChange,
  content: ContentDraft,
): FileChangeStatus {
  switch (record.statusCode) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    case "X":
      return "unknown";
    case "M":
      return record.oldMode !== record.newMode &&
        content.type === "metadata-only"
        ? "mode-changed"
        : "modified";
    default:
      throw new GitSnapshotError(
        `Git reported unsupported file status ${JSON.stringify(record.statusCode)}.`,
      );
  }
}

function parsePatchBlock(lines: readonly string[]): PatchDraft {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const binaryStart = lines.findIndex(
    (line) => line === "GIT binary patch" || line.startsWith("Binary files "),
  );
  const contentStart = minimumNonNegative(firstHunk, binaryStart);
  const gitHeaderLines =
    contentStart === -1 ? lines : lines.slice(0, contentStart);

  if (binaryStart !== -1 && (firstHunk === -1 || binaryStart < firstHunk)) {
    return {
      gitHeaderLines,
      content: {
        type: "binary",
        gitBodyLines: lines.slice(binaryStart),
        unsupportedReason: "Binary changes are not reviewable as text.",
      },
    };
  }

  if (firstHunk === -1) {
    return {
      gitHeaderLines,
      content: {
        type: "metadata-only",
        gitBodyLines: [],
        unsupportedReason: "This file change has no textual diff hunks.",
      },
    };
  }

  try {
    return {
      gitHeaderLines,
      content: {
        type: "text",
        hunks: parseHunks(lines.slice(firstHunk)),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      gitHeaderLines,
      content: {
        type: "unsupported",
        gitBodyLines: lines.slice(firstHunk),
        unsupportedReason: `DiffWalk could not parse the textual diff: ${reason}`,
      },
    };
  }
}

function minimumNonNegative(left: number, right: number): number {
  if (left === -1) return right;
  if (right === -1) return left;
  return Math.min(left, right);
}

function parseHunks(lines: readonly string[]): readonly HunkDraft[] {
  const hunks: HunkDraft[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = parseHunkHeader(requiredAt(lines, index, "hunk header"));
    index += 1;
    const diffLines: ParsedLine[] = [];
    let oldLine = header.oldStart;
    let newLine = header.newStart;
    let oldSeen = 0;
    let newSeen = 0;

    while (index < lines.length) {
      const raw = requiredAt(lines, index, "hunk line");
      if (raw.startsWith("@@ ")) break;
      if (raw.startsWith(" ")) {
        diffLines.push({ type: "context", raw, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
        oldSeen += 1;
        newSeen += 1;
      } else if (raw.startsWith("+")) {
        diffLines.push({ type: "added", raw, newLine });
        newLine += 1;
        newSeen += 1;
      } else if (raw.startsWith("-")) {
        diffLines.push({ type: "removed", raw, oldLine });
        oldLine += 1;
        oldSeen += 1;
      } else if (raw === "\\ No newline at end of file") {
        diffLines.push({ type: "no-newline-marker", raw });
      } else {
        throw new GitSnapshotError(
          `Unexpected unified diff line ${JSON.stringify(raw)}.`,
        );
      }
      index += 1;
    }

    if (oldSeen !== header.oldCount || newSeen !== header.newCount) {
      throw new GitSnapshotError(
        `Hunk ${JSON.stringify(header.raw)} declared ${header.oldCount}/${header.newCount} old/new lines but contained ${oldSeen}/${newSeen}.`,
      );
    }
    hunks.push({ header, lines: diffLines });
  }

  return hunks;
}

function parseHunkHeader(raw: string): HunkHeader {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
  if (!match) {
    throw new GitSnapshotError(
      `Unable to parse unified diff hunk header ${JSON.stringify(raw)}.`,
    );
  }
  const oldStart = requiredAt(match, 1, "hunk old start");
  const oldCount = match[2];
  const newStart = requiredAt(match, 3, "hunk new start");
  const newCount = match[4];
  return {
    raw,
    oldStart: Number.parseInt(oldStart, 10),
    oldCount: oldCount === undefined ? 1 : Number.parseInt(oldCount, 10),
    newStart: Number.parseInt(newStart, 10),
    newCount: newCount === undefined ? 1 : Number.parseInt(newCount, 10),
  };
}

export function contentBodyLines(content: ContentDraft): readonly string[] {
  if (content.type === "text") {
    return content.hunks.flatMap((hunk) => [
      hunk.header.raw,
      ...hunk.lines.map((line) => line.raw),
    ]);
  }
  return content.gitBodyLines;
}

function recordTouchesPaths(
  change: RawFileChange,
  paths: ReadonlySet<string>,
): boolean {
  return (
    (change.oldPath !== undefined && paths.has(change.oldPath)) ||
    (change.newPath !== undefined && paths.has(change.newPath))
  );
}
