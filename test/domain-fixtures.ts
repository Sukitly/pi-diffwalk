import type {
  DiffHunk,
  FileChange,
  FileChangeId,
  FileChangeStatus,
  GitObjectId,
  HunkFingerprint,
  HunkId,
  HunkReviewRecord,
  ReviewRound,
  ReviewRoundId,
  ReviewSeriesId,
  ReviewSnapshot,
  SnapshotId,
  StateFingerprint,
} from "../src/types.ts";

export interface HunkFixture {
  readonly id: string;
  readonly fingerprint: string;
  readonly path?: string;
  readonly start?: number;
  readonly count?: number;
  readonly status?: FileChangeStatus;
}

export interface SnapshotFixtureOptions {
  readonly repositoryRoot?: string;
  readonly targetRef?: string;
}

export function makeSnapshot(
  id: string,
  hunkFixtures: readonly HunkFixture[],
  options: SnapshotFixtureOptions = {},
): ReviewSnapshot {
  const grouped = new Map<string, HunkFixture[]>();
  for (const fixture of hunkFixtures) {
    const path = fixture.path ?? "src/file.ts";
    const status = fixture.status ?? "modified";
    const key = JSON.stringify({ path, status });
    const group = grouped.get(key) ?? [];
    group.push(fixture);
    grouped.set(key, group);
  }

  const changes: FileChange[] = [...grouped.values()].map((fixtures) => {
    const first = requiredAt(fixtures, 0);
    const path = first.path ?? "src/file.ts";
    const status = first.status ?? "modified";
    const fileChangeId = brand<FileChangeId>(`file:${status}:${path}`);
    return {
      id: fileChangeId,
      source: "tracked",
      status,
      oldPath: status === "added" ? undefined : path,
      newPath: status === "deleted" ? undefined : path,
      oldMode: status === "added" ? undefined : "100644",
      newMode: status === "deleted" ? undefined : "100644",
      gitHeaderLines: [],
      content: {
        kind: "text",
        hunks: fixtures.map((fixture) => makeHunk(fileChangeId, fixture)),
      },
    };
  });

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
    changes,
    notices: [],
  };
}

export function makeRound(input: {
  readonly id: string;
  readonly snapshot: ReviewSnapshot;
  readonly records: readonly HunkReviewRecord[];
  readonly seriesId?: string;
  readonly sequence?: number;
  readonly baselineRoundId?: ReviewRoundId;
}): ReviewRound {
  return {
    id: brand<ReviewRoundId>(input.id),
    seriesId: brand<ReviewSeriesId>(input.seriesId ?? "series"),
    sequence: input.sequence ?? 1,
    snapshot: input.snapshot,
    delta: {
      currentSnapshotId: input.snapshot.id,
      baselineRoundId: input.baselineRoundId,
      hunks: listHunks(input.snapshot).map((hunk) => ({
        type: "needs-review",
        hunkId: hunk.id,
        reason: "new",
      })),
      removedHunkFingerprints: [],
    },
    coverage: {
      snapshotId: input.snapshot.id,
      records: input.records,
    },
  };
}

export function listHunks(snapshot: ReviewSnapshot): readonly DiffHunk[] {
  return snapshot.changes.flatMap((change) =>
    change.content.kind === "text" ? change.content.hunks : [],
  );
}

export function hunkId(value: string): HunkId {
  return brand<HunkId>(value);
}

export function fingerprint(value: string): HunkFingerprint {
  return brand<HunkFingerprint>(value);
}

export function roundId(value: string): ReviewRoundId {
  return brand<ReviewRoundId>(value);
}

export function seriesId(value: string): ReviewSeriesId {
  return brand<ReviewSeriesId>(value);
}

function makeHunk(fileChangeId: FileChangeId, fixture: HunkFixture): DiffHunk {
  const start = fixture.start ?? 1;
  const count = fixture.count ?? 1;
  return {
    id: hunkId(fixture.id),
    fingerprint: fingerprint(fixture.fingerprint),
    fileChangeId,
    header: {
      raw: `@@ -${start},${count} +${start},${count} @@`,
      oldStart: start,
      oldCount: count,
      newStart: start,
      newCount: count,
    },
    lines: [],
  };
}

function brand<Value extends string>(value: string): Value {
  return value as Value;
}

function requiredAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  if (value === undefined)
    throw new Error(`Missing fixture value at index ${index}.`);
  return value;
}
