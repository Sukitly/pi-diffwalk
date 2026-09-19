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
  ReviewUnitKind,
  ReviewUnitSkip,
} from "./types.ts";

/**
 * The skip policy. A decision model reports surface features of a unit;
 * this module decides whether the unit reaches the walkthrough at all.
 *
 * A skipped unit is not shown in a smaller form. It never enters the
 * walkthrough, exactly like a region the agent skipped, and appears only in
 * the round summary with the reason it was dropped. The default is to skip.
 * A unit earns the reviewer's time only by showing a reason: it touches a
 * boundary, it is behavior or interface code whose runtime behavior or
 * control flow changes, or it carries a comment the reviewer left open.
 * Everything else is skipped, whatever its size. Every threshold lives here.
 */

/**
 * Initial thresholds. Each question has its own; a threshold tuned on one
 * question does not transfer to another, so none is shared.
 */
export const REVIEW_THRESHOLDS = {
  /** At or above this, a behavior or interface unit changes runtime behavior. */
  changesBehavior: 0.75,
  /** At or above this, a behavior or interface unit adds control flow. */
  newControlFlow: 0.75,
  /**
   * A choice below this confidence is no reason to review. Skipping is the
   * default, so a boundary or kind the model barely leans toward must not
   * pull the reviewer in.
   */
  choiceConfidence: 0.6,
} as const;

/** Kinds where a behavior or control-flow change is worth the reviewer's time. */
export const REVIEW_KINDS: ReadonlySet<ReviewUnitKind> = new Set([
  "behavior",
  "interface",
]);

export interface SkipGates {
  readonly hasUnresolvedComment: boolean;
}

export type SkipDecision =
  | {
      readonly review: true;
      readonly reasons: readonly string[];
      /** Absent when an open comment demanded review before any model was asked. */
      readonly features?: ReviewUnitFeatures;
    }
  | {
      readonly review: false;
      readonly reasons: readonly string[];
      readonly features: ReviewUnitFeatures;
    };

/**
 * The one gate code owns without a model: a line the reviewer commented on
 * and has not resolved always comes back to the reviewer.
 */
export function gateReasons(gates: SkipGates): readonly string[] {
  return gates.hasUnresolvedComment
    ? ["a line carries your unresolved comment"]
    : [];
}

export function decideSkip(
  features: ReviewUnitFeatures,
  gates: SkipGates,
): SkipDecision {
  const reasons: string[] = [...gateReasons(gates)];
  const boundary = confidentChoice(features.touchesBoundary, "none");
  if (boundary !== "none") {
    reasons.push(
      `touches ${describeBoundary(boundary)} (${formatProbability(features.touchesBoundary.confidence)})`,
    );
  }
  const kind = features.kind.choice;
  if (REVIEW_KINDS.has(kind) && isConfident(features.kind)) {
    if (features.changesBehavior >= REVIEW_THRESHOLDS.changesBehavior) {
      reasons.push(
        `${kind} code changes runtime behavior (${formatProbability(features.changesBehavior)})`,
      );
    }
    if (features.newControlFlow >= REVIEW_THRESHOLDS.newControlFlow) {
      reasons.push(
        `${kind} code adds control flow (${formatProbability(features.newControlFlow)})`,
      );
    }
  }
  if (reasons.length > 0) return { review: true, reasons, features };

  const summary: string[] = [`${capitalize(kind)} change, no boundary.`];
  if (REVIEW_KINDS.has(kind)) {
    summary.push(
      `No behavior change (${formatProbability(1 - features.changesBehavior)}), no new control flow (${formatProbability(1 - features.newControlFlow)}).`,
    );
  }
  if (features.mirrorsReference !== undefined) {
    summary.push(
      `Mirrors the named reference (${formatProbability(features.mirrorsReference)}).`,
    );
  }
  return { review: false, reasons: summary, features };
}

/** The agent's claim skips a unit when no decision model is configured. */
export function skipFromRoutineClaim(
  unit: ReviewUnit,
): ReviewUnitSkip | undefined {
  return unit.routine === undefined
    ? undefined
    : { source: "agent", reasons: [unit.routine.reason] };
}

function isConfident(answer: { readonly confidence: number }): boolean {
  return answer.confidence >= REVIEW_THRESHOLDS.choiceConfidence;
}

/** Below the confidence threshold a choice reads as `fallback`. */
function confidentChoice<T extends string>(
  answer: { readonly choice: T; readonly confidence: number },
  fallback: T,
): T {
  return isConfident(answer) ? answer.choice : fallback;
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
 * leaves the machine when a decision model is configured, so it is built
 * here and nowhere else.
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
  unit: Pick<ReviewUnit, "spans">,
): number {
  return unit.spans.reduce(
    (sum, span) => sum + resolvedSpanChangedLines(snapshot, span).length,
    0,
  );
}
