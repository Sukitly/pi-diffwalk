import assert from "node:assert/strict";
import type {
  ReviewCommentAnchor,
  ReviewCommentTarget,
} from "../review/comments.ts";
import { assertReviewDeltaMatchesSnapshot } from "../review/delta.ts";
import {
  changedLineKey,
  listFileChangedLines,
  resolvedSpanChangedLines,
  textContent,
} from "../review/span.ts";
import type {
  ChangeSide,
  DiffLine,
  FileChange,
  ResolvedSpan,
  ReviewDelta,
  ReviewRoute,
  ReviewSnapshot,
  ReviewUnit,
} from "../review/types.ts";
import { displayChangePath, displayPath } from "../ui/paths.ts";
import { GuidedReviewUiInvariantError } from "./errors.ts";
import type {
  ChangedLineDisplayOwnership,
  DisplayOmissionReason,
  InventoryEntry,
  PlannedDiffItem,
  SpanView,
  UnitDisplayBlock,
  UnitView,
} from "./types.ts";

export function buildReviewViewModel(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  route: ReviewRoute,
  targets: readonly ReviewCommentTarget[],
): {
  readonly units: readonly UnitView[];
  readonly inventory: readonly InventoryEntry[];
  readonly changesById: ReadonlyMap<FileChange["id"], FileChange>;
  readonly displayOwnership: ReadonlyMap<string, ChangedLineDisplayOwnership>;
  readonly unsupportedCount: number;
} {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  const changesById = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );

  const targetsByUnit = new Map<string, ReviewCommentTarget[]>();
  for (const target of targets) {
    const unitTargets = targetsByUnit.get(target.reviewUnitId) ?? [];
    unitTargets.push(target);
    targetsByUnit.set(target.reviewUnitId, unitTargets);
  }

  const displayOwnership = buildChangedLineDisplayOwnership(
    snapshot,
    delta,
    route,
  );
  const units = route.units.map((unit) => {
    const spans = unit.spans.map((span) => {
      const change = changesById.get(span.fileChangeId);
      assert.ok(
        change,
        `Validated route references missing file change ${span.fileChangeId}.`,
      );
      return { change, span, lines: sliceSpan(change, span) };
    });
    const displayBlocks = buildUnitDisplayBlocks(unit, spans, displayOwnership);
    return {
      unit,
      displayBlocks,
      targets: orderTargetsFromDisplayPlan(
        unit,
        displayBlocks,
        targetsByUnit.get(unit.id) ?? [],
      ),
    };
  });

  const requirements = new Map(
    delta.lines.map((requirement) => [
      changedLineKey(requirement),
      requirement,
    ]),
  );
  const plannedKeys = new Set<string>();
  for (const unit of route.units) {
    for (const span of unit.spans) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        plannedKeys.add(changedLineKey(line));
      }
    }
  }
  const skipReasonByKey = new Map<string, string>();
  for (const skip of route.skippedSpans) {
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      skipReasonByKey.set(changedLineKey(line), skip.reason);
    }
  }

  const inventory: InventoryEntry[] = [];
  for (const change of snapshot.changes) {
    const content = textContent(change);
    if (content === undefined) continue;
    const changed = listFileChangedLines(change);
    if (changed.length === 0) continue;
    let planned = 0;
    let skipped = 0;
    let carried = 0;
    const skipReasons = new Set<string>();
    for (const line of changed) {
      const key = changedLineKey(line);
      if (requirements.get(key)?.type === "carried-forward") {
        carried += 1;
        continue;
      }
      const reason = skipReasonByKey.get(key);
      if (reason !== undefined) {
        skipped += 1;
        skipReasons.add(reason);
        continue;
      }
      if (plannedKeys.has(key)) planned += 1;
    }
    inventory.push({
      type: "file",
      title: `${fileInventoryStatus(planned, skipped, carried)}: ${displayChangePath(change)}`,
      detail: fileInventoryDetail(
        changed.length,
        planned,
        skipped,
        carried,
        skipReasons,
      ),
      change,
      regions: buildDisplayRegions(content.lines),
    });
  }

  let unsupportedCount = 0;
  for (const change of snapshot.changes) {
    if (change.content.type === "text") continue;
    if (
      change.content.type === "binary" ||
      change.content.type === "unsupported"
    ) {
      unsupportedCount += 1;
    }
    inventory.push({
      type: change.content.type,
      title: `${change.content.type}: ${change.status}: ${displayChangePath(change)}`,
      detail: nonTextChangeDetail(change),
    });
  }
  for (const notice of snapshot.notices) {
    inventory.push({
      type: "notice",
      title: `notice: ${notice.filePath === undefined ? notice.type : displayPath(notice.filePath)}`,
      detail: notice.message,
    });
  }

  return {
    units,
    inventory,
    changesById,
    displayOwnership,
    unsupportedCount,
  };
}

function buildChangedLineDisplayOwnership(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  route: ReviewRoute,
): ReadonlyMap<string, ChangedLineDisplayOwnership> {
  const ownership = new Map<string, ChangedLineDisplayOwnership>();
  for (const unit of route.units) {
    for (const [spanIndex, span] of unit.spans.entries()) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        const key = changedLineKey(line);
        const existing = ownership.get(key);
        if (existing?.type === "unit" && existing.reviewUnitId === unit.id) {
          continue;
        }
        if (existing !== undefined) {
          throw new GuidedReviewUiInvariantError(
            `Changed line ${key} has conflicting walkthrough display ownership.`,
          );
        }
        ownership.set(key, {
          type: "unit",
          reviewUnitId: unit.id,
          unitTitle: unit.title,
          spanIndex,
        });
      }
    }
  }

  for (const skip of route.skippedSpans) {
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      const key = changedLineKey(line);
      if (ownership.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Changed line ${key} is both routed and skipped in the walkthrough display plan.`,
        );
      }
      ownership.set(key, { type: "skipped", reason: skip.reason });
    }
  }

  for (const requirement of delta.lines) {
    const key = changedLineKey(requirement);
    if (requirement.type === "carried-forward") {
      if (ownership.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Carried-forward changed line ${key} is also routed or skipped.`,
        );
      }
      ownership.set(key, { type: "carried-forward" });
    } else if (!ownership.has(key)) {
      throw new GuidedReviewUiInvariantError(
        `Changed line ${key} has no walkthrough display ownership.`,
      );
    }
  }
  return ownership;
}

function orderTargetsFromDisplayPlan(
  unit: ReviewUnit,
  blocks: readonly UnitDisplayBlock[],
  targets: readonly ReviewCommentTarget[],
): readonly ReviewCommentTarget[] {
  const targetsByLine = new Map(
    targets.map((target) => [
      fileLineKey(target.fileChangeId, target.side, target.line),
      target,
    ]),
  );
  const ordered: ReviewCommentTarget[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const item of block.items) {
      if (item.type !== "line" || item.role !== "owned") continue;
      const key = diffLineKey(block.change.id, item.line);
      if (key === undefined) continue;
      const target = targetsByLine.get(key);
      if (target === undefined) continue;
      if (seen.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Review target ${key} is rendered more than once in unit ${unit.id}.`,
        );
      }
      seen.add(key);
      ordered.push(target);
    }
  }
  for (const target of targets) {
    const key = fileLineKey(target.fileChangeId, target.side, target.line);
    if (!seen.has(key)) {
      throw new GuidedReviewUiInvariantError(
        `Review target ${key} has no rendered row in unit ${unit.id}.`,
      );
    }
  }
  return ordered;
}

const INLINE_SPAN_MERGE_GAP = 6;

interface IndexedSpanView {
  readonly spanIndex: number;
  readonly spanView: SpanView;
}

interface RouteFileBlock {
  readonly change: FileChange;
  readonly spans: IndexedSpanView[];
}

interface SpanViewBounds {
  readonly start: number;
  readonly end: number;
}

function buildUnitDisplayBlocks(
  unit: ReviewUnit,
  spans: readonly SpanView[],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
): readonly UnitDisplayBlock[] {
  const routeBlocks: RouteFileBlock[] = [];
  for (const [spanIndex, spanView] of spans.entries()) {
    const previous = routeBlocks.at(-1);
    if (previous?.change.id === spanView.change.id) {
      previous.spans.push({ spanIndex, spanView });
    } else {
      routeBlocks.push({
        change: spanView.change,
        spans: [{ spanIndex, spanView }],
      });
    }
  }
  return routeBlocks.map((block) =>
    buildRouteFileBlock(unit, block, ownership),
  );
}

function buildRouteFileBlock(
  unit: ReviewUnit,
  block: RouteFileBlock,
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
): UnitDisplayBlock {
  const content = textContent(block.change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review span references non-text file change ${block.change.id}.`,
    );
  }
  const items: PlannedDiffItem[] = [];
  const renderedIndexes = new Set<number>();
  let previousBounds: SpanViewBounds | undefined;

  for (const { spanIndex, spanView } of block.spans) {
    const bounds = spanViewBounds(spanView, content.lines);
    if (previousBounds !== undefined) {
      if (bounds.start > previousBounds.end + 1) {
        appendGapItems(
          items,
          content.lines,
          previousBounds.end + 1,
          bounds.start - 1,
          spanIndex,
          unit,
          block.change.id,
          ownership,
          renderedIndexes,
        );
      } else if (bounds.start < previousBounds.start) {
        appendDisplayOmission(items, 0, { type: "route-jump" });
      }
    }

    for (let index = bounds.start; index <= bounds.end; index += 1) {
      const line = content.lines[index];
      if (line === undefined) continue;
      appendSpanLine(
        items,
        line,
        index,
        spanIndex,
        unit,
        block.change.id,
        ownership,
        renderedIndexes,
      );
    }
    previousBounds = bounds;
  }

  return { change: block.change, items };
}

function spanViewBounds(
  spanView: SpanView,
  fileLines: readonly DiffLine[],
): SpanViewBounds {
  const firstLine = spanView.lines[0];
  const lastLine = spanView.lines.at(-1);
  if (firstLine === undefined || lastLine === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review span for file change ${spanView.change.id} has no frozen lines.`,
    );
  }
  const start = fileLines.indexOf(firstLine);
  const end = fileLines.indexOf(lastLine);
  if (start < 0 || end < start) {
    throw new GuidedReviewUiInvariantError(
      `Review span lines are not part of frozen file change ${spanView.change.id}.`,
    );
  }
  return { start, end };
}

function appendGapItems(
  items: PlannedDiffItem[],
  fileLines: readonly DiffLine[],
  start: number,
  end: number,
  nextSpanIndex: number,
  unit: ReviewUnit,
  fileChangeId: FileChange["id"],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  renderedIndexes: Set<number>,
): void {
  const showContext = end - start + 1 <= INLINE_SPAN_MERGE_GAP;
  if (!showContext) {
    appendCollapsedGap(
      items,
      fileLines,
      start,
      end,
      unit,
      fileChangeId,
      ownership,
      renderedIndexes,
    );
    return;
  }
  for (let index = start; index <= end; index += 1) {
    if (renderedIndexes.has(index)) continue;
    const line = fileLines[index];
    if (line === undefined) continue;
    if (line.type === "context") {
      items.push({ type: "line", line, role: "context" });
      renderedIndexes.add(index);
      continue;
    }
    const lineOwnership = requireDisplayOwnership(
      ownership,
      fileChangeId,
      line,
    );
    appendDisplayOmission(
      items,
      1,
      omissionReasonForOwnership(lineOwnership, unit, nextSpanIndex),
    );
    if (
      lineOwnership.type !== "unit" ||
      lineOwnership.reviewUnitId !== unit.id
    ) {
      renderedIndexes.add(index);
    }
  }
}

/**
 * A gap too long to show inline becomes one omission row. Nothing in it is
 * displayed, so alternating runs of context and earlier-round lines would
 * only add rows; the row instead counts what the gap holds by category.
 */
function appendCollapsedGap(
  items: PlannedDiffItem[],
  fileLines: readonly DiffLine[],
  start: number,
  end: number,
  unit: ReviewUnit,
  fileChangeId: FileChange["id"],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  renderedIndexes: Set<number>,
): void {
  let total = 0;
  let carriedForward = 0;
  let skipped = 0;
  let otherUnit = 0;
  let shownLater = 0;
  for (let index = start; index <= end; index += 1) {
    if (renderedIndexes.has(index)) continue;
    const line = fileLines[index];
    if (line === undefined) continue;
    total += 1;
    if (line.type === "context") {
      renderedIndexes.add(index);
      continue;
    }
    const lineOwnership = requireDisplayOwnership(
      ownership,
      fileChangeId,
      line,
    );
    switch (lineOwnership.type) {
      case "carried-forward":
        carriedForward += 1;
        renderedIndexes.add(index);
        break;
      case "skipped":
        skipped += 1;
        renderedIndexes.add(index);
        break;
      case "unit":
        if (lineOwnership.reviewUnitId === unit.id) {
          shownLater += 1;
        } else {
          otherUnit += 1;
          renderedIndexes.add(index);
        }
        break;
    }
  }
  if (total === 0) return;
  items.push({
    type: "omission",
    count: total,
    reason: { type: "gap", carriedForward, skipped, otherUnit, shownLater },
  });
}

function appendSpanLine(
  items: PlannedDiffItem[],
  line: DiffLine,
  lineIndex: number,
  spanIndex: number,
  unit: ReviewUnit,
  fileChangeId: FileChange["id"],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  renderedIndexes: Set<number>,
): void {
  if (line.type === "context") {
    if (!renderedIndexes.has(lineIndex)) {
      items.push({ type: "line", line, role: "context" });
      renderedIndexes.add(lineIndex);
    }
    return;
  }

  const lineOwnership = requireDisplayOwnership(ownership, fileChangeId, line);
  if (lineOwnership.type === "unit" && lineOwnership.reviewUnitId === unit.id) {
    if (lineOwnership.spanIndex !== spanIndex) {
      appendDisplayOmission(
        items,
        1,
        omissionReasonForOwnership(lineOwnership, unit, spanIndex),
      );
      return;
    }
    if (renderedIndexes.has(lineIndex)) {
      throw new GuidedReviewUiInvariantError(
        `Owned changed line ${diffLineKey(fileChangeId, line)} is rendered more than once in unit ${unit.id}.`,
      );
    }
    items.push({ type: "line", line, role: "owned" });
    renderedIndexes.add(lineIndex);
    return;
  }

  if (renderedIndexes.has(lineIndex)) return;
  items.push({
    type: "line",
    line,
    role: "external",
    externalDetail: externalLineDetail(lineOwnership),
  });
  renderedIndexes.add(lineIndex);
}

export function requireDisplayOwnership(
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  fileChangeId: FileChange["id"],
  line: DiffLine,
): ChangedLineDisplayOwnership {
  const key = diffLineKey(fileChangeId, line);
  if (key === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Context line of file change ${fileChangeId} has no changed-line ownership.`,
    );
  }
  const result = ownership.get(key);
  if (result === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Changed line ${key} has no walkthrough display ownership.`,
    );
  }
  return result;
}

function omissionReasonForOwnership(
  ownership: ChangedLineDisplayOwnership,
  unit: ReviewUnit,
  spanIndex: number,
): DisplayOmissionReason {
  switch (ownership.type) {
    case "carried-forward":
      return { type: "carried-forward" };
    case "skipped":
      return { type: "skipped", reason: ownership.reason };
    case "unit":
      if (ownership.reviewUnitId !== unit.id) {
        return { type: "other-unit", unitTitle: ownership.unitTitle };
      }
      return ownership.spanIndex < spanIndex
        ? { type: "shown-earlier" }
        : { type: "shown-later" };
  }
}

function externalLineDetail(ownership: ChangedLineDisplayOwnership): string {
  switch (ownership.type) {
    case "carried-forward":
      return "Reviewed in an earlier round; these changed lines are not selectable here.";
    case "skipped":
      return `Skipped from the walkthrough: ${ownership.reason}`;
    case "unit":
      return `Routed to review unit ${JSON.stringify(ownership.unitTitle)}; these changed lines are not selectable here.`;
  }
}

function appendDisplayOmission(
  items: PlannedDiffItem[],
  count: number,
  reason: DisplayOmissionReason,
): void {
  const previous = items.at(-1);
  if (
    count > 0 &&
    previous?.type === "omission" &&
    sameOmissionReason(previous.reason, reason)
  ) {
    items[items.length - 1] = {
      ...previous,
      count: previous.count + count,
    };
    return;
  }
  items.push({ type: "omission", count, reason });
}

function sameOmissionReason(
  left: DisplayOmissionReason,
  right: DisplayOmissionReason,
): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "skipped":
      return right.type === "skipped" && left.reason === right.reason;
    case "other-unit":
      return right.type === "other-unit" && left.unitTitle === right.unitTitle;
    default:
      return true;
  }
}

export function lineTarget(
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  fileChangeId: FileChange["id"],
  line: DiffLine,
): ReviewCommentTarget | undefined {
  const key = diffLineKey(fileChangeId, line);
  return key === undefined ? undefined : targetsByLine.get(key);
}

export function diffLineKey(
  fileChangeId: FileChange["id"],
  line: DiffLine,
): string | undefined {
  if (line.type === "added" && line.newLine !== undefined) {
    return fileLineKey(fileChangeId, "new", line.newLine);
  }
  if (line.type === "removed" && line.oldLine !== undefined) {
    return fileLineKey(fileChangeId, "old", line.oldLine);
  }
  return undefined;
}

/** Unchanged lines rendered around a span so a narrow region is never shown bare. */
export const SPAN_DISPLAY_CONTEXT_RADIUS = 3;

/**
 * Contiguous slice of the frozen file covering one span.
 *
 * The slice is padded with neighbouring unchanged lines so that a span drawn
 * tightly around its changed lines is still readable. Padding stops at the
 * first changed line outside the span, because that line belongs to another
 * unit and must not look reviewable here. Padding is display only and never
 * affects coverage.
 */
function sliceSpan(
  change: FileChange,
  span: ResolvedSpan,
): readonly DiffLine[] {
  const content = textContent(change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Validated route references non-text file change ${change.id}.`,
    );
  }
  let start = -1;
  let end = -1;
  for (const [index, line] of content.lines.entries()) {
    if (!lineWithinSpan(span, line)) continue;
    if (start < 0) start = index;
    end = index;
  }
  if (start < 0) return [];

  for (let padded = 0; padded < SPAN_DISPLAY_CONTEXT_RADIUS; padded += 1) {
    if (start === 0 || content.lines[start - 1]?.type !== "context") break;
    start -= 1;
  }
  for (let padded = 0; padded < SPAN_DISPLAY_CONTEXT_RADIUS; padded += 1) {
    if (
      end === content.lines.length - 1 ||
      content.lines[end + 1]?.type !== "context"
    ) {
      break;
    }
    end += 1;
  }
  return content.lines.slice(start, end + 1);
}

function lineWithinSpan(span: ResolvedSpan, line: DiffLine): boolean {
  if (
    line.oldLine !== undefined &&
    span.oldStart !== undefined &&
    span.oldEnd !== undefined &&
    line.oldLine >= span.oldStart &&
    line.oldLine <= span.oldEnd
  ) {
    return true;
  }
  return (
    line.newLine !== undefined &&
    span.newStart !== undefined &&
    span.newEnd !== undefined &&
    line.newLine >= span.newStart &&
    line.newLine <= span.newEnd
  );
}

/** Changed regions of a whole file, padded with context, for read-only inspection. */
function buildDisplayRegions(
  lines: readonly DiffLine[],
  radius = 3,
): readonly DiffLine[][] {
  const regions: DiffLine[][] = [];
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (line.type === "context") continue;
    const from = Math.max(0, index - radius);
    const to = Math.min(lines.length - 1, index + radius);
    if (start < 0) {
      start = from;
      end = to;
      continue;
    }
    if (from <= end + 1) {
      end = Math.max(end, to);
      continue;
    }
    regions.push([...lines.slice(start, end + 1)]);
    start = from;
    end = to;
  }
  if (start >= 0) regions.push([...lines.slice(start, end + 1)]);
  return regions;
}

function fileInventoryStatus(
  planned: number,
  skipped: number,
  carried: number,
): string {
  const parts: string[] = [];
  if (planned > 0) parts.push("planned");
  if (skipped > 0) parts.push("skipped");
  if (carried > 0) parts.push("carried-forward");
  return parts.length === 0 ? "unrouted" : parts.join("+");
}

function fileInventoryDetail(
  total: number,
  planned: number,
  skipped: number,
  carried: number,
  skipReasons: ReadonlySet<string>,
): string {
  const parts = [
    `${total} changed line${total === 1 ? "" : "s"}: ${planned} planned, ${skipped} skipped, ${carried} carried forward.`,
  ];
  for (const reason of skipReasons) parts.push(`Skip reason: ${reason}`);
  return parts.join(" ");
}

function nonTextChangeDetail(change: FileChange): string {
  if (change.content.type === "text") {
    throw new GuidedReviewUiInvariantError(
      `Text change ${change.id} was rendered as a non-text inventory entry.`,
    );
  }
  const details = [`Status: ${change.status}.`, `Source: ${change.source}.`];
  if (change.oldMode !== undefined || change.newMode !== undefined) {
    details.push(`Mode: ${change.oldMode ?? "-"} -> ${change.newMode ?? "-"}.`);
  }
  details.push(change.content.unsupportedReason);
  return details.join(" ");
}

export function anchorFromTarget(
  target: ReviewCommentTarget,
): ReviewCommentAnchor {
  return {
    reviewUnitId: target.reviewUnitId,
    fileChangeId: target.fileChangeId,
    side: target.side,
    line: target.line,
  };
}

export function targetKey(anchor: ReviewCommentAnchor): string {
  return `${anchor.reviewUnitId}\u0000${changedLineKey(anchor)}`;
}

export function fileLineKey(
  fileChangeId: FileChange["id"],
  side: ChangeSide,
  line: number,
): string {
  return `${fileChangeId}\u0000${side}\u0000${line}`;
}
