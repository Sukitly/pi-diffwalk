import { hashAs } from "../review/ids.ts";
import type {
  DiffLine,
  FileChange,
  FileChangeContent,
  FileChangeId,
  GitObjectId,
  ReviewSpan,
  TextChange,
} from "../review/types.ts";
import { GitSnapshotError } from "./errors.ts";
import {
  contentBodyLines,
  type FileChangeDraft,
  type HunkDraft,
  splitLines,
} from "./patch.ts";
import { type GitRunner, runGit } from "./runner.ts";

export async function buildFileChange(
  git: GitRunner,
  repositoryRoot: string,
  mergeBaseOid: GitObjectId,
  draft: FileChangeDraft,
): Promise<FileChange> {
  const id = hashAs<FileChangeId>("file-change", draft);
  let content: FileChangeContent;
  if (draft.content.type === "text") {
    const hunks = draft.content.hunks;
    try {
      const oldFile = await readOldFile(
        git,
        repositoryRoot,
        mergeBaseOid,
        draft,
      );
      content = buildTextContent(draft, hunks, oldFile);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      content = {
        type: "unsupported",
        gitBodyLines: contentBodyLines(draft.content),
        unsupportedReason: `DiffWalk could not reconstruct the frozen file content: ${reason}`,
      };
    }
  } else {
    content = draft.content;
  }
  return {
    id,
    source: draft.source,
    status: draft.status,
    oldPath: draft.oldPath,
    newPath: draft.newPath,
    oldMode: draft.oldMode,
    newMode: draft.newMode,
    gitHeaderLines: draft.gitHeaderLines,
    content,
  };
}

interface OldFileContent {
  readonly lines: readonly string[];
  readonly noTrailingNewline: boolean;
}

async function readOldFile(
  git: GitRunner,
  repositoryRoot: string,
  mergeBaseOid: GitObjectId,
  draft: FileChangeDraft,
): Promise<OldFileContent> {
  if (
    draft.source === "untracked" ||
    draft.status === "added" ||
    draft.oldPath === undefined
  ) {
    return { lines: [], noTrailingNewline: false };
  }
  const output = await runGit(
    git,
    repositoryRoot,
    ["cat-file", "blob", `${mergeBaseOid}:${draft.oldPath}`],
    [0],
    `Unable to read the frozen content of ${JSON.stringify(draft.oldPath)} at the merge base.`,
  );
  return {
    lines: splitLines(output),
    noTrailingNewline: output.length > 0 && !output.endsWith("\n"),
  };
}

/**
 * Rebuilds the whole file as one unified line sequence.
 *
 * Git only emits changed regions plus a small context radius, but a review span
 * may address any line, so the snapshot reconstructs the untouched regions from
 * the frozen old blob. The result is also the old-to-new line number mapping.
 */
function buildTextContent(
  draft: FileChangeDraft,
  hunks: readonly HunkDraft[],
  oldFile: OldFileContent,
): TextChange {
  const lines: DiffLine[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  let oldNoTrailingNewline = false;
  let newNoTrailingNewline = false;
  let markerSeen = false;

  const takeOldLine = (label: string): string => {
    const text = oldFile.lines[oldCursor - 1];
    if (text === undefined) {
      throw new GitSnapshotError(
        `The frozen old file has ${oldFile.lines.length} lines, but ${label} needs line ${oldCursor}.`,
      );
    }
    return text;
  };

  for (const hunk of hunks) {
    const oldBegin =
      hunk.header.oldCount === 0
        ? hunk.header.oldStart + 1
        : hunk.header.oldStart;
    const newBegin =
      hunk.header.newCount === 0
        ? hunk.header.newStart + 1
        : hunk.header.newStart;
    while (oldCursor < oldBegin) {
      lines.push({
        type: "context",
        oldLine: oldCursor,
        newLine: newCursor,
        text: takeOldLine(`hunk ${JSON.stringify(hunk.header.raw)}`),
      });
      oldCursor += 1;
      newCursor += 1;
    }
    if (newCursor !== newBegin) {
      throw new GitSnapshotError(
        `Hunk ${JSON.stringify(hunk.header.raw)} starts at new line ${newBegin}, but reconstruction reached new line ${newCursor}.`,
      );
    }

    let previousType: DiffLine["type"] | undefined;
    for (const line of hunk.lines) {
      if (line.type === "no-newline-marker") {
        markerSeen = true;
        if (previousType === "removed" || previousType === "context") {
          oldNoTrailingNewline = true;
        }
        if (previousType === "added" || previousType === "context") {
          newNoTrailingNewline = true;
        }
        continue;
      }
      const text = line.raw.slice(1);
      if (line.type === "context") {
        lines.push({
          type: "context",
          oldLine: oldCursor,
          newLine: newCursor,
          text,
        });
        oldCursor += 1;
        newCursor += 1;
      } else if (line.type === "added") {
        lines.push({ type: "added", newLine: newCursor, text });
        newCursor += 1;
      } else {
        lines.push({ type: "removed", oldLine: oldCursor, text });
        oldCursor += 1;
      }
      previousType = line.type;
    }
  }

  while (oldCursor <= oldFile.lines.length) {
    lines.push({
      type: "context",
      oldLine: oldCursor,
      newLine: newCursor,
      text: takeOldLine("the trailing unchanged region"),
    });
    oldCursor += 1;
    newCursor += 1;
  }

  if (!markerSeen) {
    oldNoTrailingNewline = oldFile.noTrailingNewline;
    newNoTrailingNewline = oldFile.noTrailingNewline;
  }

  const oldLineCount = lines.filter(
    (line) => line.oldLine !== undefined,
  ).length;
  const newLineCount = lines.filter(
    (line) => line.newLine !== undefined,
  ).length;
  if (oldLineCount !== oldFile.lines.length) {
    throw new GitSnapshotError(
      `Reconstruction produced ${oldLineCount} old lines, but the frozen old file has ${oldFile.lines.length}.`,
    );
  }

  return {
    type: "text",
    lines,
    oldLineCount,
    newLineCount,
    oldNoTrailingNewline,
    newNoTrailingNewline,
    suggestedSpans: buildSuggestedSpans(draft, hunks),
  };
}

/** One span per Git hunk, offered to the agent as a starting point it may redraw. */
function buildSuggestedSpans(
  draft: FileChangeDraft,
  hunks: readonly HunkDraft[],
): readonly ReviewSpan[] {
  const path = draft.newPath ?? draft.oldPath;
  if (path === undefined) return [];
  return hunks.map((hunk) => ({
    path,
    ...(hunk.header.oldCount === 0
      ? {}
      : {
          oldStart: hunk.header.oldStart,
          oldEnd: hunk.header.oldStart + hunk.header.oldCount - 1,
        }),
    ...(hunk.header.newCount === 0
      ? {}
      : {
          newStart: hunk.header.newStart,
          newEnd: hunk.header.newStart + hunk.header.newCount - 1,
        }),
  }));
}
