import {
  type ReviewRouteValidationOptions,
  validateReviewRoute,
} from "./route-validation.ts";
import { changedLineKey, resolvedSpanChangedLines } from "./span.ts";
import type {
  ReviewDelta,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewRouteSkip,
  ReviewSnapshot,
  ReviewUnit,
  ReviewUnitCandidate,
} from "./types.ts";

/**
 * A route under construction. Units arrive one at a time and each one is
 * validated against the whole draft immediately, so an error is reported
 * while it is still cheap to fix. Only the completeness rules wait for the
 * final call.
 */

export interface ReviewRouteDraft {
  readonly snapshotId: string;
  readonly units: readonly ReviewUnitCandidate[];
}

export interface ReviewRouteDraftProgress {
  readonly draft: ReviewRouteDraft;
  /** Unit count after the append, which is the unit's position in the route. */
  readonly unitCount: number;
  /** The appended unit after validation, with its resolved spans and id. */
  readonly acceptedUnit: ReviewUnit;
  readonly coveredLineCount: number;
  readonly remaining: readonly ReviewRouteRemainingFile[];
}

export interface ReviewRouteRemainingFile {
  readonly path: string;
  /** Contiguous ranges still needing review, as `old 3-7` or `new 12`. */
  readonly ranges: readonly string[];
  readonly lineCount: number;
}

export function createReviewRouteDraft(snapshotId: string): ReviewRouteDraft {
  return { snapshotId, units: [] };
}

export function appendReviewRouteUnit(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
  unit: ReviewUnitCandidate,
): ReviewRouteDraftProgress {
  const units = [...draft.units, unit];
  const route = validateDraft(snapshot, delta, draft.snapshotId, units, {
    stage: "draft",
  });
  const next: ReviewRouteDraft = { snapshotId: draft.snapshotId, units };
  const acceptedUnit = route.units.at(-1);
  if (acceptedUnit === undefined) {
    throw new Error("Route validation dropped the appended review unit.");
  }
  return {
    draft: next,
    unitCount: units.length,
    acceptedUnit,
    coveredLineCount: coveredKeys(snapshot, route).size,
    remaining: remainingFiles(snapshot, delta, route),
  };
}

/**
 * Completes the route. Skipped spans arrive here rather than with the units
 * because a skip is a statement about what the finished route leaves out.
 */
export function finishReviewRouteDraft(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
  skippedSpans: ReviewRouteCandidate["skippedSpans"],
): ReviewRoute {
  return validateDraft(
    snapshot,
    delta,
    draft.snapshotId,
    draft.units,
    {},
    skippedSpans,
  );
}

function validateDraft(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  snapshotId: string,
  units: readonly ReviewUnitCandidate[],
  options: ReviewRouteValidationOptions,
  skippedSpans: ReviewRouteCandidate["skippedSpans"] = [],
): ReviewRoute {
  const candidate = {
    snapshotId,
    units: [...units],
    skippedSpans: [...skippedSpans],
  } as ReviewRouteCandidate;
  return validateReviewRoute(snapshot, delta, candidate, options);
}

function coveredKeys(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const unit of route.units) {
    for (const span of unit.spans) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        keys.add(changedLineKey(line));
      }
    }
  }
  for (const skip of route.skippedSpans as readonly ReviewRouteSkip[]) {
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      keys.add(changedLineKey(line));
    }
  }
  return keys;
}

/** What the agent still has to route, grouped per file and compacted. */
function remainingFiles(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  route: ReviewRoute,
): readonly ReviewRouteRemainingFile[] {
  const covered = coveredKeys(snapshot, route);
  const pending = new Map<string, { old: number[]; new: number[] }>();
  for (const requirement of delta.lines) {
    if (requirement.type !== "needs-review") continue;
    if (covered.has(changedLineKey(requirement))) continue;
    const change = snapshot.changes.find(
      (candidate) => candidate.id === requirement.fileChangeId,
    );
    const path = change?.newPath ?? change?.oldPath;
    if (path === undefined) continue;
    const entry = pending.get(path) ?? { old: [], new: [] };
    entry[requirement.side === "new" ? "new" : "old"].push(requirement.line);
    pending.set(path, entry);
  }
  return [...pending.entries()].map(([path, sides]) => ({
    path,
    ranges: [
      ...compactRanges(sides.old).map((range) => `old ${range}`),
      ...compactRanges(sides.new).map((range) => `new ${range}`),
    ],
    lineCount: sides.old.length + sides.new.length,
  }));
}

function compactRanges(numbers: readonly number[]): readonly string[] {
  const sorted = [...numbers].sort((left, right) => left - right);
  const ranges: { start: number; end: number }[] = [];
  for (const value of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && last.end === value - 1) {
      last.end = value;
      continue;
    }
    ranges.push({ start: value, end: value });
  }
  return ranges.map((range) =>
    range.start === range.end
      ? `${range.start}`
      : `${range.start}-${range.end}`,
  );
}
