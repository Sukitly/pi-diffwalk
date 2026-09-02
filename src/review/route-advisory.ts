import type { DetectedMove, MoveSideRange } from "./moves.ts";
import { changedLineKey, computeSpanCoverage } from "./span.ts";
import type {
  ChangeSide,
  ReviewRoute,
  ReviewSnapshot,
  ReviewSpan,
} from "./types.ts";

/**
 * Advisory quality signals for a route that already passed validation.
 *
 * Every signal is a mechanical check for a route that looks copied from Git
 * hunks instead of planned semantically. Signals never reject a route: the
 * extension returns them to the agent at most once per review, and a
 * resubmitted identical route is accepted. The explanations live only in the
 * nudge message, at the moment of conflict, never in the kickoff prompt.
 */

/** Hunk mirroring is only meaningful once a route has a few units. */
export const HUNK_MIRRORING_MIN_UNITS = 3;
/** With fewer files, a good order is often alphabetical by coincidence. */
export const ALPHABETICAL_ORDER_MIN_FILES = 3;

export type RouteAdvisoryCode =
  | "hunk-mirroring"
  | "alphabetical-order"
  | "split-move";

export interface RouteAdvisoryIssue {
  readonly code: RouteAdvisoryCode;
  readonly message: string;
}

export function assessRouteQuality(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  moves: readonly DetectedMove[],
): readonly RouteAdvisoryIssue[] {
  const issues: RouteAdvisoryIssue[] = [];
  const mirroring = detectHunkMirroring(snapshot, route);
  if (mirroring !== undefined) issues.push(mirroring);
  const alphabetical = detectAlphabeticalOrder(route);
  if (alphabetical !== undefined) issues.push(alphabetical);
  issues.push(...detectSplitMoves(snapshot, route, moves));
  return issues;
}

/**
 * The advisory nudge returned instead of opening the walkthrough. It fires at
 * most once per review; the caller owns that bookkeeping.
 */
export class ReviewRouteAdvisoryNudge extends Error {
  readonly issues: readonly RouteAdvisoryIssue[];

  constructor(issues: readonly RouteAdvisoryIssue[]) {
    super(formatAdvisoryNudge(issues));
    this.name = "ReviewRouteAdvisoryNudge";
    this.issues = [...issues];
  }
}

export function formatAdvisoryNudge(
  issues: readonly RouteAdvisoryIssue[],
): string {
  return [
    "The route passed validation, but these signals suggest it was copied from Git hunks instead of planned semantically:",
    ...issues.map((issue) => `- ${issue.message}`),
    "These are advisory signals, not validation failures. Revise the route where a signal is right, or call the tool again with the same route to proceed.",
  ].join("\n");
}

/** Every unit copies exactly one suggested span, so the route is the hunk list. */
function detectHunkMirroring(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
): RouteAdvisoryIssue | undefined {
  if (route.units.length < HUNK_MIRRORING_MIN_UNITS) return undefined;
  const suggested = new Set<string>();
  for (const change of snapshot.changes) {
    if (change.content.type !== "text") continue;
    for (const span of change.content.suggestedSpans) {
      suggested.add(spanKey(span));
    }
  }
  const mirrors = route.units.every((unit) => {
    const span = unit.spans[0];
    return (
      unit.spans.length === 1 &&
      span !== undefined &&
      suggested.has(spanKey(span))
    );
  });
  if (!mirrors) return undefined;
  return {
    code: "hunk-mirroring",
    message: `All ${route.units.length} review units copy one suggested span each, so the route mirrors Git hunk boundaries. Hunks are artifacts of the diff algorithm: redraw spans around what a reviewer must understand together, merging related changes and separating unrelated ones.`,
  };
}

/** Single-file units walking files in alphabetical path order. */
function detectAlphabeticalOrder(
  route: ReviewRoute,
): RouteAdvisoryIssue | undefined {
  const unitPaths: string[] = [];
  for (const unit of route.units) {
    const paths = new Set(unit.spans.map((span) => span.path));
    // A cross-file unit is evidence of semantic planning; no signal.
    if (paths.size !== 1) return undefined;
    const [path] = paths;
    if (path === undefined) return undefined;
    unitPaths.push(path);
  }
  const distinct = new Set(unitPaths);
  if (distinct.size < ALPHABETICAL_ORDER_MIN_FILES) return undefined;
  for (let index = 1; index < unitPaths.length; index += 1) {
    if ((unitPaths[index - 1] ?? "") > (unitPaths[index] ?? "")) {
      return undefined;
    }
  }
  return {
    code: "alphabetical-order",
    message: `The ${route.units.length} review units walk ${distinct.size} files in alphabetical path order with no cross-file unit. Keep this order only if it matches behavior and data flow; otherwise reorder by contracts, data flow, and failure paths.`,
  };
}

/** Both sides of a detected relocation are covered, but never by one unit. */
function detectSplitMoves(
  snapshot: ReviewSnapshot,
  route: ReviewRoute,
  moves: readonly DetectedMove[],
): readonly RouteAdvisoryIssue[] {
  if (moves.length === 0) return [];
  const coverage = computeSpanCoverage(snapshot, {
    unitSpans: route.units.map((unit) => unit.spans),
    skippedSpans: route.skippedSpans.map((skip) => skip.span),
  });
  const unitByLine = new Map<string, number>();
  for (const [unitIndex, lines] of coverage.coveredByUnit.entries()) {
    for (const line of lines) {
      unitByLine.set(changedLineKey(line), unitIndex);
    }
  }

  const issues: RouteAdvisoryIssue[] = [];
  for (const move of moves) {
    const removedUnits = coveringUnits(unitByLine, move.removed, "old");
    const addedUnits = coveringUnits(unitByLine, move.added, "new");
    // A side outside the planned route (carried forward or skipped) is not
    // this signal's concern.
    if (removedUnits.size === 0 || addedUnits.size === 0) continue;
    if ([...removedUnits].some((unit) => addedUnits.has(unit))) continue;
    issues.push({
      code: "split-move",
      message: `${move.removed.path} old ${formatLines(move.removed)} and ${move.added.path} new ${formatLines(move.added)} are an exact relocation, but no review unit covers both sides. Split across units, a relocation reads as an unrelated deletion and addition.`,
    });
  }
  return issues;
}

function coveringUnits(
  unitByLine: ReadonlyMap<string, number>,
  range: MoveSideRange,
  side: ChangeSide,
): ReadonlySet<number> {
  const units = new Set<number>();
  for (let line = range.start; line <= range.end; line += 1) {
    const unit = unitByLine.get(
      changedLineKey({ fileChangeId: range.fileChangeId, side, line }),
    );
    if (unit !== undefined) units.add(unit);
  }
  return units;
}

function formatLines(range: MoveSideRange): string {
  return range.start === range.end
    ? `${range.start}`
    : `${range.start}-${range.end}`;
}

function spanKey(span: ReviewSpan): string {
  return JSON.stringify([
    span.path,
    span.oldStart ?? null,
    span.oldEnd ?? null,
    span.newStart ?? null,
    span.newEnd ?? null,
  ]);
}
