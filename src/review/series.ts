import { createHash } from "node:crypto";
import {
  assertReviewDeltaMatchesSnapshot,
  coverageFileKey,
  fileKey,
} from "./delta.ts";
import { changedLineKey, listFileChangedLines } from "./span.ts";
import type {
  ChangedLineRecord,
  ChangedLineRequirement,
  FileCoverage,
  ReviewCoverage,
  ReviewDelta,
  ReviewRound,
  ReviewRoundId,
  ReviewSeries,
  ReviewSeriesId,
  ReviewSnapshot,
} from "./types.ts";

export interface CreateReviewSeriesInput {
  readonly repositoryRoot: string;
  readonly sourceBranch: string;
  readonly targetRef: string;
}

export interface ReviewRoundIdentity {
  readonly id: ReviewRoundId;
  readonly sequence: number;
}

export class ReviewSeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSeriesError";
  }
}

export function createReviewSeries(
  input: CreateReviewSeriesInput,
): ReviewSeries {
  assertNonEmpty(input.repositoryRoot, "Repository root");
  assertNonEmpty(input.sourceBranch, "Source branch");
  assertNonEmpty(input.targetRef, "Target ref");
  return {
    id: hashAs<ReviewSeriesId>("review-series", {
      repositoryRoot: input.repositoryRoot,
      sourceBranch: input.sourceBranch,
      targetRef: input.targetRef,
    }),
    repositoryRoot: input.repositoryRoot,
    sourceBranch: input.sourceBranch,
    targetRef: input.targetRef,
    rounds: [],
  };
}

export function getNextReviewRoundIdentity(
  series: ReviewSeries,
  snapshot: ReviewSnapshot,
): ReviewRoundIdentity {
  validateSeriesHistory(series);
  validateSnapshotBelongsToSeries(series, snapshot);
  const previous = series.rounds.at(-1);
  const sequence = previous === undefined ? 1 : previous.sequence + 1;
  return {
    id: hashAs<ReviewRoundId>("review-round", {
      seriesId: series.id,
      sequence,
      snapshotId: snapshot.id,
    }),
    sequence,
  };
}

export function createReviewRound(
  series: ReviewSeries,
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  coverage: ReviewCoverage,
): ReviewRound {
  const identity = getNextReviewRoundIdentity(series, snapshot);
  validateRoundData(
    identity,
    snapshot,
    delta,
    coverage,
    series.rounds.at(-1)?.id,
    new Set(series.rounds.map((round) => round.id)),
  );
  return {
    id: identity.id,
    seriesId: series.id,
    sequence: identity.sequence,
    snapshot,
    delta,
    coverage,
  };
}

export function appendReviewRound(
  series: ReviewSeries,
  round: ReviewRound,
): ReviewSeries {
  const expected = createReviewRound(
    series,
    round.snapshot,
    round.delta,
    round.coverage,
  );
  if (round.id !== expected.id) {
    throw new ReviewSeriesError(
      `Round ID ${round.id} does not match expected ID ${expected.id}.`,
    );
  }
  if (round.seriesId !== series.id) {
    throw new ReviewSeriesError(
      `Round ${round.id} belongs to series ${round.seriesId}, not ${series.id}.`,
    );
  }
  if (round.sequence !== expected.sequence) {
    throw new ReviewSeriesError(
      `Round ${round.id} has sequence ${round.sequence}, expected ${expected.sequence}.`,
    );
  }
  return { ...series, rounds: [...series.rounds, round] };
}

function validateRoundData(
  identity: ReviewRoundIdentity,
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  coverage: ReviewCoverage,
  expectedBaselineRoundId: ReviewRoundId | undefined,
  priorRoundIds: ReadonlySet<ReviewRoundId>,
): void {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  if (coverage.snapshotId !== snapshot.id) {
    throw new ReviewSeriesError(
      `Review coverage references snapshot ${coverage.snapshotId}, not ${snapshot.id}.`,
    );
  }

  if (delta.baselineRoundId !== expectedBaselineRoundId) {
    throw new ReviewSeriesError(
      `Review delta baseline ${String(delta.baselineRoundId)} does not match expected baseline ${String(expectedBaselineRoundId)}.`,
    );
  }

  const requirements = new Map(
    delta.lines.map((requirement) => [
      changedLineKey(requirement),
      requirement,
    ]),
  );
  const coverageByFile = new Map<string, FileCoverage>();
  for (const file of coverage.files) {
    const key = fileKey(file.oldPath, file.newPath);
    if (coverageByFile.has(key)) {
      throw new ReviewSeriesError(
        `Review coverage contains duplicate entries for ${key}.`,
      );
    }
    coverageByFile.set(key, file);
  }

  const seenFiles = new Set<string>();
  for (const change of snapshot.changes) {
    const changedLines = listFileChangedLines(change);
    if (changedLines.length === 0) continue;
    const key = coverageFileKey(change);
    const path = change.newPath ?? change.oldPath ?? change.id;
    const file = coverageByFile.get(key);
    if (file === undefined) {
      throw new ReviewSeriesError(
        `Review coverage does not cover changed file ${path}.`,
      );
    }
    seenFiles.add(key);
    if (file.lines.length !== changedLines.length) {
      throw new ReviewSeriesError(
        `Review coverage for ${path} has ${file.lines.length} records, but the snapshot has ${changedLines.length} changed lines.`,
      );
    }
    for (const [index, line] of changedLines.entries()) {
      const record = file.lines[index];
      if (
        record === undefined ||
        record.side !== line.side ||
        record.line !== line.line ||
        record.text !== line.text
      ) {
        throw new ReviewSeriesError(
          `Review coverage for ${path} does not match snapshot ${line.side} line ${line.line}.`,
        );
      }
      const requirement = requirements.get(changedLineKey(line));
      if (requirement === undefined) {
        throw new ReviewSeriesError(
          `Round data is incomplete for ${path} ${line.side} line ${line.line}.`,
        );
      }
      validateRecordProvenance(
        identity.id,
        priorRoundIds,
        requirement,
        record,
        `${path} ${line.side} line ${line.line}`,
      );
    }
  }

  for (const key of coverageByFile.keys()) {
    if (!seenFiles.has(key)) {
      throw new ReviewSeriesError(
        `Review coverage contains an entry for ${key}, which has no changed lines in the snapshot.`,
      );
    }
  }
}

function validateRecordProvenance(
  currentRoundId: ReviewRoundId,
  priorRoundIds: ReadonlySet<ReviewRoundId>,
  requirement: ChangedLineRequirement,
  record: ChangedLineRecord,
  label: string,
): void {
  if (record.disposition === "commented") {
    if (record.commentedInRoundId !== currentRoundId) {
      throw new ReviewSeriesError(
        `Commented ${label} must reference current round ${currentRoundId}.`,
      );
    }
    return;
  }
  if (record.disposition === "skipped") {
    if (requirement.type === "carried-forward") {
      throw new ReviewSeriesError(
        `Carried-forward ${label} cannot be skipped.`,
      );
    }
    if (record.skipReason.trim().length === 0) {
      throw new ReviewSeriesError(
        `Skipped ${label} requires a non-empty reason.`,
      );
    }
    if (record.skippedInRoundId !== currentRoundId) {
      throw new ReviewSeriesError(
        `Skipped ${label} must reference current round ${currentRoundId}.`,
      );
    }
    return;
  }

  if (
    requirement.type === "carried-forward" &&
    !priorRoundIds.has(requirement.reviewedInRoundId)
  ) {
    throw new ReviewSeriesError(
      `Carried-forward ${label} references unknown prior round ${requirement.reviewedInRoundId}.`,
    );
  }
  const expectedRoundId =
    requirement.type === "carried-forward"
      ? requirement.reviewedInRoundId
      : currentRoundId;
  if (record.reviewedInRoundId !== expectedRoundId) {
    throw new ReviewSeriesError(
      `Reviewed ${label} references round ${record.reviewedInRoundId}, expected ${expectedRoundId}.`,
    );
  }
}

function validateSnapshotBelongsToSeries(
  series: ReviewSeries,
  snapshot: ReviewSnapshot,
): void {
  if (snapshot.repositoryRoot !== series.repositoryRoot) {
    throw new ReviewSeriesError(
      `Snapshot repository ${snapshot.repositoryRoot} does not match series repository ${series.repositoryRoot}.`,
    );
  }
  if (snapshot.comparison.targetRef !== series.targetRef) {
    throw new ReviewSeriesError(
      `Snapshot target ${snapshot.comparison.targetRef} does not match series target ${series.targetRef}.`,
    );
  }
}

function validateSeriesHistory(series: ReviewSeries): void {
  let expectedSequence = 1;
  let expectedBaselineRoundId: ReviewRoundId | undefined;
  const roundIds = new Set<ReviewRoundId>();
  for (const round of series.rounds) {
    if (round.seriesId !== series.id) {
      throw new ReviewSeriesError(
        `Round ${round.id} belongs to series ${round.seriesId}, not ${series.id}.`,
      );
    }
    if (round.sequence !== expectedSequence) {
      throw new ReviewSeriesError(
        `Round ${round.id} has sequence ${round.sequence}, expected ${expectedSequence}.`,
      );
    }
    if (roundIds.has(round.id)) {
      throw new ReviewSeriesError(
        `Series ${series.id} contains duplicate round ID ${round.id}.`,
      );
    }
    validateSnapshotBelongsToSeries(series, round.snapshot);
    const expectedId = hashAs<ReviewRoundId>("review-round", {
      seriesId: series.id,
      sequence: expectedSequence,
      snapshotId: round.snapshot.id,
    });
    if (round.id !== expectedId) {
      throw new ReviewSeriesError(
        `Round ID ${round.id} does not match expected ID ${expectedId}.`,
      );
    }
    validateRoundData(
      { id: round.id, sequence: round.sequence },
      round.snapshot,
      round.delta,
      round.coverage,
      expectedBaselineRoundId,
      roundIds,
    );
    roundIds.add(round.id);
    expectedBaselineRoundId = round.id;
    expectedSequence += 1;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ReviewSeriesError(`${label} is required.`);
  }
}

function hashAs<Value extends string>(
  namespace: string,
  value: unknown,
): Value {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(JSON.stringify(value));
  return `${namespace}:${hash.digest("hex")}` as Value;
}
