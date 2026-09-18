import {
  resolvedSpanChangedLines,
  spanCoversLine,
  textContent,
} from "./span.ts";
import type {
  ReviewSnapshot,
  ReviewUnit,
  ReviewUnitBoundary,
  ReviewUnitFeatures,
  ReviewUnitFold,
  ReviewUnitKind,
} from "./types.ts";

/**
 * The fold policy. A decision model reports surface features of a unit; this
 * module turns them into a yes or no and into the reasons the reviewer sees
 * on the folded card. Every threshold lives here. The model never decides
 * alone: size and unresolved comments are hard gates the code owns.
 */

/** A folded unit is small by definition; the same cap the routine claim uses. */
export const FOLD_MAX_CHANGED_LINES = 40;

/**
 * Initial thresholds. Each question has its own; a threshold tuned on one
 * question does not transfer to another, so none is shared.
 */
export const FOLD_THRESHOLDS = {
  /** Above this, the unit changes behavior and must be walked. */
  changesBehavior: 0.75,
  /** Above this, the unit adds control flow and must be walked. */
  newControlFlow: 0.75,
  /** Below this, a reference the agent named is not trusted. */
  mirrorsReference: 0.75,
  /** A choice below this confidence is treated as its unsafe alternative. */
  choiceConfidence: 0.6,
} as const;

export const FOLDABLE_KINDS: ReadonlySet<ReviewUnitKind> = new Set([
  "test",
  "config",
  "docs",
  "refactor",
  "generated",
]);

export interface FoldGates {
  readonly changedLineCount: number;
  readonly hasUnresolvedComment: boolean;
  readonly hasReference: boolean;
}

export type FoldDecision =
  | { readonly fold: true; readonly result: ReviewUnitFold }
  | {
      readonly fold: false;
      readonly blockers: readonly string[];
      readonly features: ReviewUnitFeatures;
    };

export function decideFold(
  features: ReviewUnitFeatures,
  gates: FoldGates,
): FoldDecision {
  const blockers: string[] = [];
  if (gates.changedLineCount > FOLD_MAX_CHANGED_LINES) {
    blockers.push(
      `${gates.changedLineCount} changed lines exceed the fold limit of ${FOLD_MAX_CHANGED_LINES}`,
    );
  }
  if (gates.hasUnresolvedComment) {
    blockers.push("a line carries an unresolved comment");
  }
  if (features.changesBehavior >= FOLD_THRESHOLDS.changesBehavior) {
    blockers.push(
      `changes runtime behavior (${formatProbability(features.changesBehavior)})`,
    );
  }
  if (features.newControlFlow >= FOLD_THRESHOLDS.newControlFlow) {
    blockers.push(
      `adds control flow (${formatProbability(features.newControlFlow)})`,
    );
  }
  const boundary = confidentChoice(
    features.touchesBoundary,
    "public-api" as ReviewUnitBoundary,
  );
  if (boundary !== "none") {
    blockers.push(`touches ${describeBoundary(boundary)}`);
  }
  const kind = confidentChoice(features.kind, "behavior" as ReviewUnitKind);
  if (!FOLDABLE_KINDS.has(kind)) {
    blockers.push(`is a ${kind} change`);
  }
  if (gates.hasReference) {
    if (features.mirrorsReference === undefined) {
      blockers.push("the named reference was not checked");
    } else if (features.mirrorsReference < FOLD_THRESHOLDS.mirrorsReference) {
      blockers.push(
        `does not mirror the named reference (${formatProbability(features.mirrorsReference)})`,
      );
    }
  }
  if (blockers.length > 0) return { fold: false, blockers, features };

  const reasons = [
    `No behavior change (${formatProbability(1 - features.changesBehavior)}), no new control flow (${formatProbability(1 - features.newControlFlow)}).`,
    `${capitalize(kind)} change touching no boundary.`,
  ];
  if (features.mirrorsReference !== undefined) {
    reasons.push(
      `Mirrors the named reference (${formatProbability(features.mirrorsReference)}).`,
    );
  }
  return { fold: true, result: { source: "typesafe", reasons, features } };
}

/** The agent's claim folds a unit when no decision model is configured. */
export function foldFromRoutineClaim(
  unit: ReviewUnit,
): ReviewUnitFold | undefined {
  return unit.routine === undefined
    ? undefined
    : { source: "agent", reasons: [unit.routine.reason] };
}

/**
 * Below the confidence threshold a choice is replaced by the alternative
 * that blocks a fold, so an uncertain model never folds by default.
 */
function confidentChoice<T extends string>(
  answer: { readonly choice: T; readonly confidence: number },
  unsafe: T,
): T {
  return answer.confidence >= FOLD_THRESHOLDS.choiceConfidence
    ? answer.choice
    : unsafe;
}

function describeBoundary(boundary: ReviewUnitBoundary): string {
  switch (boundary) {
    case "none":
      return "no boundary";
    case "public-api":
      return "a public API or type";
    case "persisted-format":
      return "a persisted or exchanged format";
    case "authorization":
      return "authorization";
    case "money":
      return "money";
    case "external-process":
      return "an external process";
  }
}

function formatProbability(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

/** Lines of unified diff text a decision model reads for one unit. */
export const UNIT_TEXT_CONTEXT_LINES = 3;

/**
 * The unit's spans as unified diff text with a little context, one block
 * per span, headed by the path. This is the only repository content that
 * leaves the machine when folding is enabled, so it is built here and
 * nowhere else.
 */
export function renderUnitText(
  snapshot: ReviewSnapshot,
  unit: ReviewUnit,
): string {
  const blocks: string[] = [];
  for (const span of unit.spans) {
    const change = snapshot.changes.find(
      (candidate) => candidate.id === span.fileChangeId,
    );
    const content = change === undefined ? undefined : textContent(change);
    if (change === undefined || content === undefined) continue;
    const lines = content.lines;
    const inSpan = lines.map((line) => {
      if (line.type === "added") {
        return (
          line.newLine !== undefined &&
          spanCoversLine(span, "new", line.newLine)
        );
      }
      if (line.type === "removed") {
        return (
          line.oldLine !== undefined &&
          spanCoversLine(span, "old", line.oldLine)
        );
      }
      return (
        (line.oldLine !== undefined &&
          spanCoversLine(span, "old", line.oldLine)) ||
        (line.newLine !== undefined &&
          spanCoversLine(span, "new", line.newLine))
      );
    });
    const shown = new Set<number>();
    for (const [index, inside] of inSpan.entries()) {
      if (!inside) continue;
      for (
        let offset = -UNIT_TEXT_CONTEXT_LINES;
        offset <= UNIT_TEXT_CONTEXT_LINES;
        offset += 1
      ) {
        const at = index + offset;
        if (at >= 0 && at < lines.length) shown.add(at);
      }
    }
    const rendered: string[] = [`--- ${span.path}`];
    let previous = -2;
    for (const index of [...shown].sort((left, right) => left - right)) {
      if (index !== previous + 1) rendered.push("@@");
      const line = lines[index];
      if (line === undefined) continue;
      const marker =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      rendered.push(`${marker}${line.text}`);
      previous = index;
    }
    blocks.push(rendered.join("\n"));
  }
  return blocks.join("\n\n");
}

export function unitChangedLineCount(
  snapshot: ReviewSnapshot,
  unit: ReviewUnit,
): number {
  return unit.spans.reduce(
    (sum, span) => sum + resolvedSpanChangedLines(snapshot, span).length,
    0,
  );
}
