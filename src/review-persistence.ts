import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ReviewSeries } from "./types.ts";

/**
 * Completed review rounds are the baseline for carried-forward classification.
 * They previously lived only in extension memory, so a pi restart or /reload
 * erased the series history and the next review treated every line as new.
 *
 * Each submitted round appends one session entry (pi.appendEntry) holding the
 * whole series. Session entries do not participate in LLM context. On
 * session_start the entries are scanned and the latest entry per series wins.
 *
 * Parsing treats the session file as untrusted external input: an entry that
 * fails the format version or the structural schema is ignored instead of
 * crashing session start. A stale format after an upgrade is an expected
 * case, not an error. Cross-field consistency (round hashes, sequence order)
 * is not re-checked here; the review-series validators enforce it the next
 * time a round is appended.
 */

export const DIFFWALK_SERIES_ENTRY_TYPE = "diffwalk-series";
export const REVIEW_SERIES_ENTRY_FORMAT_VERSION = 1;

export interface ReviewSeriesEntry {
  readonly formatVersion: typeof REVIEW_SERIES_ENTRY_FORMAT_VERSION;
  readonly series: ReviewSeries;
}

const LineNumber = Type.Integer({ minimum: 1 });
const Count = Type.Integer({ minimum: 0 });
const Side = Type.Union([Type.Literal("old"), Type.Literal("new")]);

const ComparisonSchema = Type.Object(
  {
    targetRef: Type.String(),
    targetOid: Type.String(),
    sourceHeadOid: Type.String(),
    mergeBaseOid: Type.String(),
    sourceBranch: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const RepositoryStateSchema = Type.Object(
  {
    headOid: Type.String(),
    stagedFingerprint: Type.String(),
    unstagedFingerprint: Type.String(),
    untrackedFingerprint: Type.String(),
  },
  { additionalProperties: false },
);

const ReviewSpanSchema = Type.Object(
  {
    path: Type.String(),
    oldStart: Type.Optional(LineNumber),
    oldEnd: Type.Optional(LineNumber),
    newStart: Type.Optional(LineNumber),
    newEnd: Type.Optional(LineNumber),
  },
  { additionalProperties: false },
);

const DiffLineSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("context"),
      Type.Literal("added"),
      Type.Literal("removed"),
    ]),
    oldLine: Type.Optional(LineNumber),
    newLine: Type.Optional(LineNumber),
    text: Type.String(),
  },
  { additionalProperties: false },
);

const TextChangeSchema = Type.Object(
  {
    type: Type.Literal("text"),
    lines: Type.Array(DiffLineSchema),
    oldLineCount: Count,
    newLineCount: Count,
    oldNoTrailingNewline: Type.Boolean(),
    newNoTrailingNewline: Type.Boolean(),
    suggestedSpans: Type.Array(ReviewSpanSchema),
  },
  { additionalProperties: false },
);

const NonTextChangeSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("binary"),
      Type.Literal("metadata-only"),
      Type.Literal("unsupported"),
    ]),
    gitBodyLines: Type.Array(Type.String()),
    unsupportedReason: Type.String(),
  },
  { additionalProperties: false },
);

const FileChangeSchema = Type.Object(
  {
    id: Type.String(),
    source: Type.Union([Type.Literal("tracked"), Type.Literal("untracked")]),
    status: Type.Union([
      Type.Literal("added"),
      Type.Literal("modified"),
      Type.Literal("deleted"),
      Type.Literal("renamed"),
      Type.Literal("copied"),
      Type.Literal("mode-changed"),
      Type.Literal("type-changed"),
      Type.Literal("unmerged"),
      Type.Literal("unknown"),
    ]),
    oldPath: Type.Optional(Type.String()),
    newPath: Type.Optional(Type.String()),
    oldMode: Type.Optional(Type.String()),
    newMode: Type.Optional(Type.String()),
    gitHeaderLines: Type.Array(Type.String()),
    content: Type.Union([TextChangeSchema, NonTextChangeSchema]),
  },
  { additionalProperties: false },
);

const SnapshotNoticeSchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("cancelled-layer-change"),
    fileChangeId: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const SnapshotSchema = Type.Object(
  {
    id: Type.String(),
    repositoryRoot: Type.String(),
    comparison: ComparisonSchema,
    repositoryState: RepositoryStateSchema,
    changes: Type.Array(FileChangeSchema),
    notices: Type.Array(SnapshotNoticeSchema),
  },
  { additionalProperties: false },
);

const ChangedLineRequirementSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("needs-review"),
      reason: Type.Union([
        Type.Literal("new"),
        Type.Literal("unresolved-comment"),
        Type.Literal("previously-skipped"),
      ]),
      fileChangeId: Type.String(),
      side: Side,
      line: LineNumber,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("carried-forward"),
      reviewedInRoundId: Type.String(),
      fileChangeId: Type.String(),
      side: Side,
      line: LineNumber,
    },
    { additionalProperties: false },
  ),
]);

const ReviewDeltaSchema = Type.Object(
  {
    currentSnapshotId: Type.String(),
    baselineRoundId: Type.Optional(Type.String()),
    lines: Type.Array(ChangedLineRequirementSchema),
    removedLineCount: Count,
  },
  { additionalProperties: false },
);

const ChangedLineRecordSchema = Type.Union([
  Type.Object(
    {
      side: Side,
      line: LineNumber,
      text: Type.String(),
      disposition: Type.Literal("reviewed-without-comment"),
      reviewedInRoundId: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      side: Side,
      line: LineNumber,
      text: Type.String(),
      disposition: Type.Literal("commented"),
      commentedInRoundId: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      side: Side,
      line: LineNumber,
      text: Type.String(),
      disposition: Type.Literal("skipped"),
      skippedInRoundId: Type.String(),
      skipReason: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

const FileCoverageSchema = Type.Object(
  {
    oldPath: Type.Optional(Type.String()),
    newPath: Type.Optional(Type.String()),
    lines: Type.Array(ChangedLineRecordSchema),
  },
  { additionalProperties: false },
);

const ReviewCoverageSchema = Type.Object(
  {
    snapshotId: Type.String(),
    files: Type.Array(FileCoverageSchema),
  },
  { additionalProperties: false },
);

const ReviewRoundSchema = Type.Object(
  {
    id: Type.String(),
    seriesId: Type.String(),
    sequence: LineNumber,
    snapshot: SnapshotSchema,
    delta: ReviewDeltaSchema,
    coverage: ReviewCoverageSchema,
  },
  { additionalProperties: false },
);

const ReviewSeriesSchema = Type.Object(
  {
    id: Type.String(),
    repositoryRoot: Type.String(),
    sourceBranch: Type.String(),
    targetRef: Type.String(),
    rounds: Type.Array(ReviewRoundSchema),
  },
  { additionalProperties: false },
);

const ReviewSeriesEntrySchema = Type.Object(
  {
    formatVersion: Type.Literal(REVIEW_SERIES_ENTRY_FORMAT_VERSION),
    series: ReviewSeriesSchema,
  },
  { additionalProperties: false },
);

export function serializeReviewSeriesEntry(
  series: ReviewSeries,
): ReviewSeriesEntry {
  return { formatVersion: REVIEW_SERIES_ENTRY_FORMAT_VERSION, series };
}

export function parseReviewSeriesEntry(
  data: unknown,
): ReviewSeries | undefined {
  if (!Value.Check(ReviewSeriesEntrySchema, data)) {
    return undefined;
  }
  // The schema mirrors the JSON shape exactly; the branded identifier types
  // exist only at compile time, so the checked value is a valid ReviewSeries.
  return (data as unknown as ReviewSeriesEntry).series;
}
