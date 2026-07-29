import type {
  DiffHunk,
  FileChange,
  HunkFingerprint,
  HunkId,
  HunkReviewRecord,
  HunkReviewRequirement,
  NeedsReviewHunk,
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

interface HunkEntry {
  readonly hunk: DiffHunk;
  readonly fileKey: string;
}

interface BaselineHunkEntry extends HunkEntry {
  readonly record: HunkReviewRecord;
}

export function computeReviewDelta(
  snapshot: ReviewSnapshot,
  baseline?: ReviewRound,
): ReviewDelta {
  const currentEntries = collectHunkEntries(snapshot);
  if (baseline === undefined) {
    return {
      currentSnapshotId: snapshot.id,
      hunks: currentEntries.map(({ hunk }) => ({
        type: "needs-review",
        hunkId: hunk.id,
        reason: "new",
      })),
      removedHunkFingerprints: [],
    };
  }

  const baselineEntries = collectBaselineEntries(baseline);
  const requirements = new Map<HunkId, HunkReviewRequirement>();
  const consumedBaselineIds = new Set<HunkId>();
  matchExactFingerprints(
    currentEntries,
    baselineEntries,
    requirements,
    consumedBaselineIds,
  );
  matchChangedHunks(
    currentEntries,
    baselineEntries,
    requirements,
    consumedBaselineIds,
  );

  return {
    currentSnapshotId: snapshot.id,
    baselineRoundId: baseline.id,
    hunks: currentEntries.map(({ hunk }) => {
      const requirement = requirements.get(hunk.id);
      if (requirement === undefined) {
        throw new ReviewDeltaError(
          `No review requirement was calculated for hunk ${hunk.id}.`,
        );
      }
      return requirement;
    }),
    removedHunkFingerprints: baselineEntries
      .filter(({ hunk }) => !consumedBaselineIds.has(hunk.id))
      .map(({ hunk }) => hunk.fingerprint),
  };
}

export function listSnapshotHunks(
  snapshot: ReviewSnapshot,
): readonly DiffHunk[] {
  return collectHunkEntries(snapshot).map(({ hunk }) => hunk);
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

  const snapshotHunkIds = new Set(
    listSnapshotHunks(snapshot).map((hunk) => hunk.id),
  );
  const requirementHunkIds = new Set<HunkId>();
  for (const requirement of delta.hunks) {
    if (!snapshotHunkIds.has(requirement.hunkId)) {
      throw new ReviewDeltaError(
        `Review delta contains unknown hunk ${requirement.hunkId}.`,
      );
    }
    if (requirementHunkIds.has(requirement.hunkId)) {
      throw new ReviewDeltaError(
        `Review delta contains duplicate hunk ${requirement.hunkId}.`,
      );
    }
    requirementHunkIds.add(requirement.hunkId);
  }
  for (const hunkId of snapshotHunkIds) {
    if (!requirementHunkIds.has(hunkId)) {
      throw new ReviewDeltaError(
        `Review delta does not cover snapshot hunk ${hunkId}.`,
      );
    }
  }
}

export function isNeedsReviewReasonSkippable(
  reason: NeedsReviewHunk["reason"],
): boolean {
  switch (reason) {
    case "unresolved-comment":
      return false;
    case "new":
    case "changed":
    case "previously-skipped":
    case "ambiguous-match":
      return true;
  }
}

function collectHunkEntries(snapshot: ReviewSnapshot): readonly HunkEntry[] {
  const entries: HunkEntry[] = [];
  const seenHunkIds = new Set<HunkId>();
  const seenFileChangeIds = new Set<string>();

  for (const change of snapshot.changes) {
    if (seenFileChangeIds.has(change.id)) {
      throw new ReviewDeltaError(
        `Snapshot ${snapshot.id} contains duplicate file change ID ${change.id}.`,
      );
    }
    seenFileChangeIds.add(change.id);
    if (change.content.kind !== "text") continue;
    for (const hunk of change.content.hunks) {
      if (hunk.fileChangeId !== change.id) {
        throw new ReviewDeltaError(
          `Hunk ${hunk.id} references file change ${hunk.fileChangeId}, but its parent is ${change.id}.`,
        );
      }
      if (seenHunkIds.has(hunk.id)) {
        throw new ReviewDeltaError(
          `Snapshot ${snapshot.id} contains duplicate hunk ID ${hunk.id}.`,
        );
      }
      seenHunkIds.add(hunk.id);
      entries.push({ hunk, fileKey: fileKey(change) });
    }
  }

  return entries;
}

function collectBaselineEntries(
  baseline: ReviewRound,
): readonly BaselineHunkEntry[] {
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

  const hunkEntries = collectHunkEntries(baseline.snapshot);
  const records = new Map<HunkId, HunkReviewRecord>();
  for (const record of baseline.coverage.records) {
    if (records.has(record.hunkId)) {
      throw new ReviewDeltaError(
        `Baseline round ${baseline.id} contains duplicate coverage for hunk ${record.hunkId}.`,
      );
    }
    records.set(record.hunkId, record);
  }

  const baselineHunkIds = new Set(hunkEntries.map(({ hunk }) => hunk.id));
  for (const record of baseline.coverage.records) {
    if (!baselineHunkIds.has(record.hunkId)) {
      throw new ReviewDeltaError(
        `Baseline round ${baseline.id} contains coverage for unknown hunk ${record.hunkId}.`,
      );
    }
  }

  return hunkEntries.map((entry) => {
    const record = records.get(entry.hunk.id);
    if (record === undefined) {
      throw new ReviewDeltaError(
        `Baseline round ${baseline.id} has no coverage for hunk ${entry.hunk.id}.`,
      );
    }
    if (record.fingerprint !== entry.hunk.fingerprint) {
      throw new ReviewDeltaError(
        `Baseline coverage fingerprint ${record.fingerprint} does not match hunk ${entry.hunk.id} fingerprint ${entry.hunk.fingerprint}.`,
      );
    }
    return { ...entry, record };
  });
}

function matchExactFingerprints(
  currentEntries: readonly HunkEntry[],
  baselineEntries: readonly BaselineHunkEntry[],
  requirements: Map<HunkId, HunkReviewRequirement>,
  consumedBaselineIds: Set<HunkId>,
): void {
  const currentGroups = groupByFingerprint(currentEntries);
  const baselineGroups = groupByFingerprint(baselineEntries);

  for (const [fingerprint, currentGroup] of currentGroups) {
    const baselineGroup = baselineGroups.get(fingerprint);
    if (baselineGroup === undefined) continue;

    if (currentGroup.length === 1 && baselineGroup.length === 1) {
      const current = requiredAt(currentGroup, 0, "current exact hunk");
      const previous = requiredAt(baselineGroup, 0, "baseline exact hunk");
      requirements.set(
        current.hunk.id,
        requirementFromExactMatch(current.hunk, previous.record),
      );
      consumedBaselineIds.add(previous.hunk.id);
      continue;
    }

    for (const current of currentGroup) {
      requirements.set(current.hunk.id, {
        type: "needs-review",
        hunkId: current.hunk.id,
        reason: "ambiguous-match",
        previousFingerprint: fingerprint,
      });
    }
    for (
      let index = 0;
      index < Math.min(currentGroup.length, baselineGroup.length);
      index += 1
    ) {
      consumedBaselineIds.add(
        requiredAt(baselineGroup, index, "ambiguous baseline hunk").hunk.id,
      );
    }
  }
}

function matchChangedHunks(
  currentEntries: readonly HunkEntry[],
  baselineEntries: readonly BaselineHunkEntry[],
  requirements: Map<HunkId, HunkReviewRequirement>,
  consumedBaselineIds: Set<HunkId>,
): void {
  const currentUnmatched = currentEntries.filter(
    ({ hunk }) => !requirements.has(hunk.id),
  );
  const baselineUnmatched = baselineEntries.filter(
    ({ hunk }) => !consumedBaselineIds.has(hunk.id),
  );
  const candidatesByCurrent = new Map<HunkId, readonly BaselineHunkEntry[]>();
  const currentIdsByBaseline = new Map<HunkId, HunkId[]>();

  for (const current of currentUnmatched) {
    const candidates = baselineUnmatched.filter(
      (previous) =>
        previous.fileKey === current.fileKey &&
        rangesOverlap(previous.hunk, current.hunk),
    );
    candidatesByCurrent.set(current.hunk.id, candidates);
    for (const candidate of candidates) {
      const currentIds = currentIdsByBaseline.get(candidate.hunk.id) ?? [];
      currentIds.push(current.hunk.id);
      currentIdsByBaseline.set(candidate.hunk.id, currentIds);
    }
  }

  for (const current of currentUnmatched) {
    const candidates = candidatesByCurrent.get(current.hunk.id) ?? [];
    if (candidates.length === 0) {
      requirements.set(current.hunk.id, {
        type: "needs-review",
        hunkId: current.hunk.id,
        reason: "new",
      });
      continue;
    }

    const candidate =
      candidates.length === 1
        ? requiredAt(candidates, 0, "changed hunk candidate")
        : undefined;
    const reverseCandidates =
      candidate === undefined
        ? []
        : (currentIdsByBaseline.get(candidate.hunk.id) ?? []);
    if (candidate !== undefined && reverseCandidates.length === 1) {
      requirements.set(
        current.hunk.id,
        requirementFromChangedMatch(current.hunk, candidate.record),
      );
      consumedBaselineIds.add(candidate.hunk.id);
      continue;
    }

    requirements.set(current.hunk.id, {
      type: "needs-review",
      hunkId: current.hunk.id,
      reason: "ambiguous-match",
    });
    for (const ambiguousCandidate of candidates) {
      consumedBaselineIds.add(ambiguousCandidate.hunk.id);
    }
  }
}

function requirementFromExactMatch(
  current: DiffHunk,
  record: HunkReviewRecord,
): HunkReviewRequirement {
  switch (record.disposition) {
    case "reviewed-without-comment":
      return {
        type: "carried-forward",
        hunkId: current.id,
        reviewedInRoundId: record.reviewedInRoundId,
      };
    case "commented":
      return needsReviewFromRecord(current, record, "unresolved-comment");
    case "skipped":
      return needsReviewFromRecord(current, record, "previously-skipped");
  }
}

function requirementFromChangedMatch(
  current: DiffHunk,
  record: HunkReviewRecord,
): NeedsReviewHunk {
  switch (record.disposition) {
    case "commented":
      return needsReviewFromRecord(current, record, "unresolved-comment");
    case "skipped":
      return needsReviewFromRecord(current, record, "previously-skipped");
    case "reviewed-without-comment":
      return needsReviewFromRecord(current, record, "changed");
  }
}

function needsReviewFromRecord(
  current: DiffHunk,
  record: HunkReviewRecord,
  reason: NeedsReviewHunk["reason"],
): NeedsReviewHunk {
  return {
    type: "needs-review",
    hunkId: current.id,
    reason,
    previousFingerprint: record.fingerprint,
  };
}

function groupByFingerprint<Entry extends HunkEntry>(
  entries: readonly Entry[],
): Map<HunkFingerprint, Entry[]> {
  const groups = new Map<HunkFingerprint, Entry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.hunk.fingerprint) ?? [];
    group.push(entry);
    groups.set(entry.hunk.fingerprint, group);
  }
  return groups;
}

function rangesOverlap(left: DiffHunk, right: DiffHunk): boolean {
  const leftStart = left.header.newStart;
  const leftEnd = leftStart + Math.max(left.header.newCount, 1);
  const rightStart = right.header.newStart;
  const rightEnd = rightStart + Math.max(right.header.newCount, 1);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function fileKey(change: FileChange): string {
  return JSON.stringify({
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
  });
}

function requiredAt<Value>(
  values: readonly Value[],
  index: number,
  label: string,
): Value {
  const value = values[index];
  if (value === undefined) {
    throw new ReviewDeltaError(`Missing ${label} at index ${index}.`);
  }
  return value;
}
