import type {
  ChangedLineRecord,
  DiffLine,
  FileChange,
  FileChangeId,
  FileChangeSource,
  FileChangeStatus,
  FileCoverage,
  GitObjectId,
  ReviewRound,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewSnapshot,
  ReviewSpan,
  SnapshotId,
  StateFingerprint,
} from "../src/types.ts";

/**
 * One changed file, written as a unified line spec.
 *
 * Each entry starts with a diff marker: a space for context, `+` for an added
 * line, `-` for a removed line. The spec covers the whole file, which is what
 * the snapshot model stores.
 */
export interface FileFixture {
  readonly path?: string;
  readonly oldPath?: string;
  readonly status?: FileChangeStatus;
  readonly source?: FileChangeSource;
  readonly lines: readonly string[];
}

export interface SnapshotFixtureOptions {
  readonly repositoryRoot?: string;
  readonly targetRef?: string;
  readonly changes?: readonly FileChange[];
  readonly notices?: ReviewSnapshot["notices"];
}

export function makeSnapshot(
  id: string,
  files: readonly FileFixture[],
  options: SnapshotFixtureOptions = {},
): ReviewSnapshot {
  const changes = files.map((file) => makeFileChange(file));
  return {
    id: brand<SnapshotId>(id),
    repositoryRoot: options.repositoryRoot ?? "/repo",
    comparison: {
      targetRef: options.targetRef ?? "main",
      targetOid: brand<GitObjectId>("1".repeat(40)),
      sourceHeadOid: brand<GitObjectId>("2".repeat(40)),
      mergeBaseOid: brand<GitObjectId>("1".repeat(40)),
    },
    repositoryState: {
      headOid: brand<GitObjectId>("2".repeat(40)),
      stagedFingerprint: brand<StateFingerprint>(`staged:${id}`),
      unstagedFingerprint: brand<StateFingerprint>(`unstaged:${id}`),
      untrackedFingerprint: brand<StateFingerprint>(`untracked:${id}`),
    },
    changes: [...changes, ...(options.changes ?? [])],
    notices: options.notices ?? [],
  };
}

export function makeFileChange(file: FileFixture): FileChange {
  const status = file.status ?? "modified";
  const path = file.path ?? "src/file.ts";
  const oldPath = status === "added" ? undefined : (file.oldPath ?? path);
  const newPath = status === "deleted" ? undefined : path;
  const lines = buildLines(file.lines);
  return {
    id: fileChangeId(status, path),
    source: file.source ?? "tracked",
    status,
    oldPath,
    newPath,
    oldMode: status === "added" ? undefined : "100644",
    newMode: status === "deleted" ? undefined : "100644",
    gitHeaderLines: [],
    content: {
      type: "text",
      lines,
      oldLineCount: lines.filter((line) => line.oldLine !== undefined).length,
      newLineCount: lines.filter((line) => line.newLine !== undefined).length,
      oldNoTrailingNewline: false,
      newNoTrailingNewline: false,
      suggestedSpans: buildSuggestedSpans(newPath ?? oldPath ?? path, lines),
    },
  };
}

function buildLines(spec: readonly string[]): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const raw of spec) {
    const marker = raw.slice(0, 1);
    const text = raw.slice(1);
    if (marker === "+") {
      lines.push({ type: "added", newLine, text });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({ type: "removed", oldLine, text });
      oldLine += 1;
    } else {
      lines.push({ type: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

/** One span per contiguous changed run, covering exactly the changed lines. */
function buildSuggestedSpans(
  path: string,
  lines: readonly DiffLine[],
): readonly ReviewSpan[] {
  const spans: ReviewSpan[] = [];
  let current: {
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
  } | null = null;

  const flush = (): void => {
    if (current === null) return;
    spans.push({ path, ...current });
    current = null;
  };

  for (const line of lines) {
    if (line.type === "context") {
      flush();
      continue;
    }
    current ??= {};
    if (line.oldLine !== undefined) {
      current.oldStart ??= line.oldLine;
      current.oldEnd = line.oldLine;
    }
    if (line.newLine !== undefined) {
      current.newStart ??= line.newLine;
      current.newEnd = line.newLine;
    }
  }
  flush();
  return spans;
}

export interface RoundFixtureInput {
  readonly id: string;
  readonly snapshot: ReviewSnapshot;
  readonly seriesId?: string;
  readonly sequence?: number;
  readonly baselineRoundId?: ReviewRoundId;
  /**
   * Overrides keyed by `path:side:line`. Anything unlisted is recorded as
   * reviewed without comment in this round.
   */
  readonly dispositions?: Readonly<
    Record<string, "commented" | "skipped" | "reviewed-without-comment">
  >;
  readonly skipReason?: string;
}

export function makeRound(input: RoundFixtureInput): ReviewRound {
  const roundIdValue = brand<ReviewRoundId>(input.id);
  const dispositions = input.dispositions ?? {};
  const skipReason = input.skipReason ?? "Fixture skip.";

  const files: FileCoverage[] = [];
  for (const change of input.snapshot.changes) {
    if (change.content.type !== "text") continue;
    const path = change.newPath ?? change.oldPath ?? "";
    const records: ChangedLineRecord[] = [];
    for (const line of change.content.lines) {
      if (line.type === "context") continue;
      const side = line.type === "added" ? "new" : "old";
      const number = line.type === "added" ? line.newLine : line.oldLine;
      if (number === undefined) continue;
      const disposition =
        dispositions[`${path}:${side}:${number}`] ?? "reviewed-without-comment";
      records.push(
        disposition === "commented"
          ? {
              side,
              line: number,
              text: line.text,
              disposition,
              commentedInRoundId: roundIdValue,
            }
          : disposition === "skipped"
            ? {
                side,
                line: number,
                text: line.text,
                disposition,
                skippedInRoundId: roundIdValue,
                skipReason,
              }
            : {
                side,
                line: number,
                text: line.text,
                disposition,
                reviewedInRoundId: roundIdValue,
              },
      );
    }
    if (records.length === 0) continue;
    files.push({
      oldPath: change.oldPath,
      newPath: change.newPath,
      lines: records,
    });
  }

  return {
    id: roundIdValue,
    seriesId: brand<ReviewSeriesId>(input.seriesId ?? "series"),
    sequence: input.sequence ?? 1,
    snapshot: input.snapshot,
    delta: {
      currentSnapshotId: input.snapshot.id,
      baselineRoundId: input.baselineRoundId,
      lines: files.flatMap((file) => {
        const change = input.snapshot.changes.find(
          (candidate) =>
            candidate.oldPath === file.oldPath &&
            candidate.newPath === file.newPath,
        );
        if (change === undefined) return [];
        return file.lines.map((record) => ({
          type: "needs-review" as const,
          fileChangeId: change.id,
          side: record.side,
          line: record.line,
          reason: "new" as const,
        }));
      }),
      removedLineCount: 0,
    },
    coverage: { snapshotId: input.snapshot.id, files },
  };
}

export function span(
  path: string,
  ranges: {
    readonly old?: readonly [number, number];
    readonly new?: readonly [number, number];
  },
): ReviewSpan {
  return {
    path,
    ...(ranges.old === undefined
      ? {}
      : { oldStart: ranges.old[0], oldEnd: ranges.old[1] }),
    ...(ranges.new === undefined
      ? {}
      : { newStart: ranges.new[0], newEnd: ranges.new[1] }),
  };
}

export function fileChangeId(
  status: FileChangeStatus,
  path: string,
): FileChangeId {
  return brand<FileChangeId>(`file:${status}:${path}`);
}

export function roundId(value: string): ReviewRoundId {
  return brand<ReviewRoundId>(value);
}

export function seriesId(value: string): ReviewSeriesId {
  return brand<ReviewSeriesId>(value);
}

function brand<Value extends string>(value: string): Value {
  return value as Value;
}
