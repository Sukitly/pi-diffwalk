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
  ReviewSkipCandidate,
  ReviewSkippedUnit,
  ReviewSnapshot,
  ReviewUnit,
  ReviewUnitCandidate,
  ReviewUnitSkip,
  ReviewUnitVerdict,
} from "./types.ts";

/**
 * A route under construction. Units and skips arrive one at a time and each
 * one is validated against the whole draft immediately, so an error is
 * reported while it is still cheap to fix. Only the completeness rules wait
 * for the final call.
 */

export interface ReviewRouteDraft {
  readonly snapshotId: string;
  readonly units: readonly ReviewUnitCandidate[];
  /**
   * Judge verdict for each accepted unit by position. A `skip` verdict keeps
   * the unit out of the walkthrough entirely: its spans become skipped spans,
   * like a region the agent skipped. `undefined` means no judge ran.
   */
  readonly verdicts: readonly (ReviewUnitVerdict | undefined)[];
  readonly skippedSpans: readonly ReviewSkipCandidate[];
}

export interface ReviewRouteDraftProgress {
  readonly draft: ReviewRouteDraft;
  /** Accepted unit count after the append, whether walked or skipped. */
  readonly unitCount: number;
  /** The appended unit after validation, with its resolved spans and id. */
  readonly acceptedUnit: ReviewUnit;
  /** Present when a judge kept the unit out of the walkthrough. */
  readonly skip?: ReviewUnitSkip;
  readonly coveredLineCount: number;
  readonly remaining: readonly ReviewRouteRemainingFile[];
}

export interface ReviewRouteSkipProgress {
  readonly draft: ReviewRouteDraft;
  readonly acceptedSkip: ReviewRouteSkip;
  /** Changed lines the skip removed from the remaining work. */
  readonly skippedLineCount: number;
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
  return { snapshotId, units: [], verdicts: [], skippedSpans: [] };
}

export function appendReviewRouteUnit(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
  unit: ReviewUnitCandidate,
): ReviewRouteDraftProgress {
  const next: ReviewRouteDraft = {
    ...draft,
    units: [...draft.units, unit],
    verdicts: [...draft.verdicts, undefined],
  };
  const route = validateDraft(snapshot, delta, next, { stage: "draft" });
  const acceptedUnit = route.units.at(-1);
  if (acceptedUnit === undefined) {
    throw new Error("Route validation dropped the appended review unit.");
  }
  return {
    draft: next,
    unitCount: next.units.length,
    acceptedUnit,
    coveredLineCount: coveredKeys(snapshot, route).size,
    remaining: remainingFiles(snapshot, delta, route),
  };
}

/**
 * Records the judge's verdict for the most recently appended unit. A skip
 * moves the unit's spans to the skipped set, so the reviewer never walks it.
 * A skip that the route rules reject, such as one covering an unresolved
 * comment, is refused and the unit stays in the walkthrough.
 */
export function recordLastUnitVerdict(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  progress: ReviewRouteDraftProgress,
  verdict: ReviewUnitVerdict | undefined,
): ReviewRouteDraftProgress {
  const draft = progress.draft;
  if (draft.units.length === 0) {
    throw new Error("Cannot record a verdict before a unit has been appended.");
  }
  if (verdict === undefined || verdict.outcome === "review") return progress;
  const verdicts = [...draft.verdicts];
  verdicts[draft.units.length - 1] = verdict;
  const next: ReviewRouteDraft = { ...draft, verdicts };
  let route: ReviewRoute;
  try {
    route = validateDraft(snapshot, delta, next, { stage: "draft" });
  } catch {
    return progress;
  }
  const { outcome: _outcome, ...skip } = verdict;
  return {
    draft: next,
    unitCount: next.units.length,
    acceptedUnit: progress.acceptedUnit,
    skip,
    coveredLineCount: coveredKeys(snapshot, route).size,
    remaining: remainingFiles(snapshot, delta, route),
  };
}

/**
 * A skip is the agent's decision that a region needs no unit. It is checked
 * as it arrives, like a unit, so the remaining-work report stays honest.
 */
export function appendReviewRouteSkip(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
  skip: ReviewSkipCandidate,
): ReviewRouteSkipProgress {
  const next: ReviewRouteDraft = {
    ...draft,
    skippedSpans: [...draft.skippedSpans, skip],
  };
  const route = validateDraft(snapshot, delta, next, { stage: "draft" });
  const acceptedSkip = route.skippedSpans.at(-1);
  if (acceptedSkip === undefined) {
    throw new Error("Route validation dropped the appended skip.");
  }
  return {
    draft: next,
    acceptedSkip,
    skippedLineCount: resolvedSpanChangedLines(snapshot, acceptedSkip.span)
      .length,
    coveredLineCount: coveredKeys(snapshot, route).size,
    remaining: remainingFiles(snapshot, delta, route),
  };
}

/** Completes the route: every remaining rule is a completeness rule. */
export function finishReviewRouteDraft(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
): ReviewRoute {
  return validateDraft(snapshot, delta, draft, {});
}

/** Units held back by a judge, paired with their candidate spans. */
function skippedUnitsOf(
  draft: ReviewRouteDraft,
): readonly { unit: ReviewUnitCandidate; skip: ReviewUnitSkip }[] {
  const skipped: { unit: ReviewUnitCandidate; skip: ReviewUnitSkip }[] = [];
  for (const [index, unit] of draft.units.entries()) {
    const verdict = draft.verdicts[index];
    if (verdict === undefined || verdict.outcome !== "skip") continue;
    const { outcome: _outcome, ...skip } = verdict;
    skipped.push({ unit, skip });
  }
  return skipped;
}

/**
 * Validates the draft as the reviewer will receive it: a unit a judge
 * skipped is not a unit at all, so it is validated as skipped spans and
 * reported in `skippedUnits`, never in `units`.
 */
function validateDraft(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  draft: ReviewRouteDraft,
  options: ReviewRouteValidationOptions,
): ReviewRoute {
  const skipped = skippedUnitsOf(draft);
  const walked = draft.units.filter(
    (_unit, index) => draft.verdicts[index]?.outcome !== "skip",
  );
  const judgedSkips = skipped.flatMap(({ unit, skip }) =>
    unit.spans.map((span) => ({
      span,
      reason: `${unit.title}: ${skip.reasons.join(" ")}`,
    })),
  );
  const candidate = {
    snapshotId: draft.snapshotId,
    units: walked,
    skippedSpans: [...draft.skippedSpans, ...judgedSkips],
  } as ReviewRouteCandidate;
  const route = validateReviewRoute(snapshot, delta, candidate, {
    ...options,
    ...(skipped.length === 0 ? {} : { allowUnitlessRoute: true }),
  });
  const agentSkipCount = draft.skippedSpans.length;
  const resolved = route.skippedSpans.slice(agentSkipCount);
  const skippedUnits: ReviewSkippedUnit[] = [];
  let offset = 0;
  for (const { unit, skip } of skipped) {
    const spans = resolved
      .slice(offset, offset + unit.spans.length)
      .map((entry) => entry.span);
    offset += unit.spans.length;
    skippedUnits.push({
      title: unit.title,
      skip,
      spans,
      changedLineCount: spans.reduce(
        (sum, span) => sum + resolvedSpanChangedLines(snapshot, span).length,
        0,
      ),
    });
  }
  return { ...route, skippedUnits } as ReviewRoute;
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
