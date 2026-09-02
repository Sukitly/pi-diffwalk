import { createHash } from "node:crypto";
import {
  assertReviewDeltaMatchesSnapshot,
  isNeedsReviewReasonSkippable,
} from "./delta.ts";
import {
  type ChangedLine,
  changedLineKey,
  computeSpanCoverage,
  describeChangedLines,
  describeSpan,
  findChangeByPath,
  listFileChangedLines,
  resolveSpan,
  spanCoversLine,
} from "./span.ts";
import type {
  ChangedLineRequirement,
  ResolvedSpan,
  ReviewCheck,
  ReviewCheckCandidate,
  ReviewDelta,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewRouteSkip,
  ReviewSnapshot,
  ReviewSpanCandidate,
  ReviewUnit,
  ReviewUnitId,
} from "./types.ts";

export type ReviewRouteValidationIssueCode =
  | "snapshot-mismatch"
  | "empty-field"
  | "review-focus-limit"
  | "invalid-check-anchor"
  | "empty-unit"
  | "invalid-span"
  | "carried-forward-reference"
  | "duplicate-coverage"
  | "missing-coverage"
  | "empty-skip-reason"
  | "unresolved-comment-skip"
  | "skip-coverage-conflict"
  | "missing-review-unit";

export interface ReviewRouteValidationIssue {
  readonly code: ReviewRouteValidationIssueCode;
  readonly message: string;
}

export class ReviewRouteValidationError extends Error {
  readonly issues: readonly ReviewRouteValidationIssue[];

  constructor(issues: readonly ReviewRouteValidationIssue[]) {
    super(
      `Invalid review route:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}`,
    );
    this.name = "ReviewRouteValidationError";
    this.issues = [...issues];
  }
}

export function validateReviewRoute(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  candidate: ReviewRouteCandidate,
): ReviewRoute {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  const issues: ReviewRouteValidationIssue[] = [];
  const requirements = new Map(
    delta.lines.map((requirement) => [
      changedLineKey(requirement),
      requirement,
    ]),
  );

  if (candidate.snapshotId !== snapshot.id) {
    issues.push({
      code: "snapshot-mismatch",
      message: `Route references snapshot ${candidate.snapshotId}, not ${snapshot.id}.`,
    });
  }

  const unitSpans: ResolvedSpan[][] = [];
  const units = candidate.units.map((unit, unitIndex) => {
    const unitNumber = unitIndex + 1;
    validateNonBlank(unit.title, `Review unit ${unitNumber} title`, issues);
    validateNonBlank(unit.whyHere, `Review unit ${unitNumber} whyHere`, issues);
    validateNonBlank(unit.context, `Review unit ${unitNumber} context`, issues);
    validateNonBlank(
      unit.changeSummary,
      `Review unit ${unitNumber} changeSummary`,
      issues,
    );
    if (unit.reviewFocus.length === 0) {
      issues.push({
        code: "empty-field",
        message: `Review unit ${unitNumber} requires at least one review focus question.`,
      });
    } else if (unit.reviewFocus.length > 3) {
      issues.push({
        code: "review-focus-limit",
        message: `Review unit ${unitNumber} has ${unit.reviewFocus.length} review focus questions; at most three are allowed.`,
      });
    }
    for (const [focusIndex, focus] of unit.reviewFocus.entries()) {
      validateNonBlank(
        focus.question,
        `Review unit ${unitNumber} reviewFocus item ${focusIndex + 1}`,
        issues,
      );
    }
    if (unit.spans.length === 0) {
      issues.push({
        code: "empty-unit",
        message: `Review unit ${unitNumber} must reference at least one span.`,
      });
    }

    const spans = unit.spans.flatMap((span, spanIndex) => {
      const result = resolveSpan(
        snapshot,
        span,
        `Review unit ${unitNumber} span ${spanIndex + 1} (${describeSpan(span)})`,
      );
      for (const issue of result.issues) {
        issues.push({ code: "invalid-span", message: issue.message });
      }
      return result.span === undefined ? [] : [result.span];
    });
    unitSpans.push(spans);

    const reviewFocus = unit.reviewFocus.map((check, checkIndex) =>
      resolveCheck(
        snapshot,
        check,
        spans,
        `Review unit ${unitNumber} check ${checkIndex + 1}`,
        issues,
      ),
    );

    return {
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus,
      spans,
    };
  });

  const skippedSpans: ReviewRouteSkip[] = candidate.skippedSpans.flatMap(
    (skipped, skipIndex) => {
      const skipNumber = skipIndex + 1;
      if (skipped.reason.trim().length === 0) {
        issues.push({
          code: "empty-skip-reason",
          message: `Skipped span ${skipNumber} (${describeSpan(skipped.span)}) requires a non-empty reason.`,
        });
      }
      const result = resolveSpan(
        snapshot,
        skipped.span,
        `Skipped span ${skipNumber} (${describeSpan(skipped.span)})`,
      );
      for (const issue of result.issues) {
        issues.push({ code: "invalid-span", message: issue.message });
      }
      return result.span === undefined
        ? []
        : [{ span: result.span, reason: skipped.reason }];
    },
  );

  const coverage = computeSpanCoverage(snapshot, {
    unitSpans,
    skippedSpans: skippedSpans.map((skip) => skip.span),
  });

  for (const duplicate of coverage.duplicated) {
    issues.push({
      code: "duplicate-coverage",
      message: `${describeLine(snapshot, duplicate.line)} is covered by review units ${duplicate.unitIndexes
        .map((index) => index + 1)
        .join(", ")}. Every changed line must belong to exactly one unit.`,
    });
  }

  for (const line of coverage.conflicting) {
    issues.push({
      code: "skip-coverage-conflict",
      message: `${describeLine(snapshot, line)} is both covered by a review unit and explicitly skipped.`,
    });
  }

  const carriedForward: ChangedLine[] = [];
  const unskippable: ChangedLine[] = [];
  for (const lines of coverage.coveredByUnit) {
    for (const line of lines) {
      if (requirementOf(requirements, line)?.type === "carried-forward") {
        carriedForward.push(line);
      }
    }
  }
  for (const line of coverage.skipped) {
    const requirement = requirementOf(requirements, line);
    if (requirement === undefined) continue;
    if (requirement.type === "carried-forward") {
      carriedForward.push(line);
      continue;
    }
    if (!isNeedsReviewReasonSkippable(requirement.reason)) {
      unskippable.push(line);
    }
  }

  for (const description of describeChangedLines(snapshot, carriedForward)) {
    issues.push({
      code: "carried-forward-reference",
      message: `${description} was reviewed in an earlier round and must stay outside the planned route.`,
    });
  }
  for (const description of describeChangedLines(snapshot, unskippable)) {
    issues.push({
      code: "unresolved-comment-skip",
      message: `${description} has an unresolved comment and cannot be skipped.`,
    });
  }

  const uncovered = coverage.uncovered.filter(
    (line) => requirementOf(requirements, line)?.type === "needs-review",
  );
  for (const description of describeChangedLines(snapshot, uncovered)) {
    issues.push({
      code: "missing-coverage",
      message: `${description} needs review but no unit covers it and no skip excludes it.`,
    });
  }

  const needsReviewExists = delta.lines.some(
    (requirement) => requirement.type === "needs-review",
  );
  if (needsReviewExists && !unitSpans.some((spans) => spans.length > 0)) {
    issues.push({
      code: "missing-review-unit",
      message:
        "A route with changed lines requiring review must contain at least one review unit with spans.",
    });
  }

  throwIfIssues(issues);

  return {
    snapshotId: snapshot.id,
    units: units.map(
      (unit, index): ReviewUnit => ({
        id: createReviewUnitId(snapshot.id, index, unit.spans),
        ...unit,
      }),
    ),
    skippedSpans,
  } as unknown as ReviewRoute;
}

/**
 * A check anchor must be a changed line that this unit's spans cover, so the
 * question renders beneath a line the reviewer sees in this unit. Anchors on
 * context lines are rejected like comment anchors are.
 */
function resolveCheck(
  snapshot: ReviewSnapshot,
  check: ReviewCheckCandidate,
  spans: readonly ResolvedSpan[],
  location: string,
  issues: ReviewRouteValidationIssue[],
): ReviewCheck {
  const question = check.question;
  if (check.anchor === undefined) return { question };
  const { path, side, line } = check.anchor;
  const where = `${JSON.stringify(path)} ${side} ${line}`;
  const change = findChangeByPath(snapshot, path);
  if (change === undefined) {
    issues.push({
      code: "invalid-check-anchor",
      message: `${location} anchors ${where}, which is not a changed file in this snapshot.`,
    });
    return { question };
  }
  const changed = listFileChangedLines(change).some(
    (candidate) => candidate.side === side && candidate.line === line,
  );
  const covered = spans.some(
    (span) =>
      span.fileChangeId === change.id && spanCoversLine(span, side, line),
  );
  if (!changed || !covered) {
    issues.push({
      code: "invalid-check-anchor",
      message: `${location} anchors ${where}, which is not a changed line inside this unit's spans.`,
    });
    return { question };
  }
  return {
    question,
    anchor: { fileChangeId: change.id, path, side, line },
  };
}

function requirementOf(
  requirements: ReadonlyMap<string, ChangedLineRequirement>,
  line: ChangedLine,
): ChangedLineRequirement | undefined {
  return requirements.get(changedLineKey(line));
}

function describeLine(snapshot: ReviewSnapshot, line: ChangedLine): string {
  return describeChangedLines(snapshot, [line])[0] ?? "A changed line";
}

function validateNonBlank(
  value: string,
  label: string,
  issues: ReviewRouteValidationIssue[],
): void {
  if (value.trim().length === 0) {
    issues.push({
      code: "empty-field",
      message: `${label} must not be blank.`,
    });
  }
}

function throwIfIssues(issues: readonly ReviewRouteValidationIssue[]): void {
  if (issues.length > 0) throw new ReviewRouteValidationError(issues);
}

function createReviewUnitId(
  snapshotId: string,
  unitIndex: number,
  spans: readonly ResolvedSpan[],
): ReviewUnitId {
  const hash = createHash("sha256");
  hash.update("review-unit");
  hash.update("\0");
  hash.update(
    JSON.stringify({
      snapshotId,
      sequence: unitIndex + 1,
      spans: spans.map((span) => ({
        fileChangeId: span.fileChangeId,
        oldStart: span.oldStart ?? null,
        oldEnd: span.oldEnd ?? null,
        newStart: span.newStart ?? null,
        newEnd: span.newEnd ?? null,
      })),
    }),
  );
  return `review-unit:${hash.digest("hex")}` as ReviewUnitId;
}

/** Rebuilds the model-facing candidate shape from a validated route. */
export function routeAsCandidate(route: ReviewRoute): ReviewRouteCandidate {
  return {
    snapshotId: route.snapshotId,
    units: route.units.map((unit) => ({
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus: unit.reviewFocus.map((check) => ({
        question: check.question,
        ...(check.anchor === undefined
          ? {}
          : {
              anchor: {
                path: check.anchor.path,
                side: check.anchor.side,
                line: check.anchor.line,
              },
            }),
      })),
      spans: unit.spans.map((span) => spanCandidate(span)),
    })),
    skippedSpans: route.skippedSpans.map((skip) => ({
      span: spanCandidate(skip.span),
      reason: skip.reason,
    })),
  };
}

function spanCandidate(span: ResolvedSpan): ReviewSpanCandidate {
  return {
    path: span.path,
    ...(span.oldStart === undefined
      ? {}
      : { oldStart: span.oldStart, oldEnd: span.oldEnd }),
    ...(span.newStart === undefined
      ? {}
      : { newStart: span.newStart, newEnd: span.newEnd }),
  } as ReviewSpanCandidate;
}
