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
 * The attention policy. A decision model reports surface features of a
 * unit; this module decides whether the unit needs the reviewer at all.
 *
 * The default is to fold. A unit earns attention only by showing a reason:
 * it touches a boundary, it is behavior or interface code whose runtime
 * behavior or control flow changes, or it carries a comment the reviewer
 * left open. Everything else folds, whatever its size. Every threshold
 * lives here.
 */

/**
 * Initial thresholds. Each question has its own; a threshold tuned on one
 * question does not transfer to another, so none is shared.
 */
export const ATTENTION_THRESHOLDS = {
  /** At or above this, a behavior or interface unit changes runtime behavior. */
  changesBehavior: 0.75,
  /** At or above this, a behavior or interface unit adds control flow. */
  newControlFlow: 0.75,
} as const;

/** Kinds where a behavior or control-flow change is worth the reviewer's time. */
export const ATTENTION_KINDS: ReadonlySet<ReviewUnitKind> = new Set([
  "behavior",
  "interface",
]);

export interface AttentionGates {
  readonly hasUnresolvedComment: boolean;
}

export type AttentionDecision =
  | { readonly attention: false; readonly fold: ReviewUnitFold }
  | {
      readonly attention: true;
      readonly reasons: readonly string[];
      /** Absent when an open comment demanded attention before any model was asked. */
      readonly features?: ReviewUnitFeatures;
    };

/**
 * The one gate code owns without a model: a line the reviewer commented on
 * and has not resolved always comes back to the reviewer.
 */
export function gateReasons(gates: AttentionGates): readonly string[] {
  return gates.hasUnresolvedComment
    ? ["a line carries your unresolved comment"]
    : [];
}

export function decideAttention(
  features: ReviewUnitFeatures,
  gates: AttentionGates,
): AttentionDecision {
  const reasons: string[] = [...gateReasons(gates)];
  const boundary = features.touchesBoundary.choice;
  if (boundary !== "none") {
    reasons.push(
      `touches ${describeBoundary(boundary)} (${formatProbability(features.touchesBoundary.confidence)})`,
    );
  }
  const kind = features.kind.choice;
  if (ATTENTION_KINDS.has(kind)) {
    if (features.changesBehavior >= ATTENTION_THRESHOLDS.changesBehavior) {
      reasons.push(
        `${kind} code changes runtime behavior (${formatProbability(features.changesBehavior)})`,
      );
    }
    if (features.newControlFlow >= ATTENTION_THRESHOLDS.newControlFlow) {
      reasons.push(
        `${kind} code adds control flow (${formatProbability(features.newControlFlow)})`,
      );
    }
  }
  if (reasons.length > 0) return { attention: true, reasons, features };

  const summary: string[] = [`${capitalize(kind)} change, no boundary.`];
  if (ATTENTION_KINDS.has(kind)) {
    summary.push(
      `No behavior change (${formatProbability(1 - features.changesBehavior)}), no new control flow (${formatProbability(1 - features.newControlFlow)}).`,
    );
  }
  if (features.mirrorsReference !== undefined) {
    summary.push(
      `Mirrors the named reference (${formatProbability(features.mirrorsReference)}).`,
    );
  }
  return {
    attention: false,
    fold: { source: "typesafe", reasons: summary, features },
  };
}

/** The agent's claim folds a unit when no decision model is configured. */
export function foldFromRoutineClaim(
  unit: ReviewUnit,
): ReviewUnitFold | undefined {
  return unit.routine === undefined
    ? undefined
    : { source: "agent", reasons: [unit.routine.reason] };
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
