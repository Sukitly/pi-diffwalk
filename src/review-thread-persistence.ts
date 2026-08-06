import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ReviewThreadBatch } from "./types.ts";

export const DIFFWALK_THREAD_BATCH_ENTRY_TYPE = "diffwalk-thread-batch";
export const REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION = 1;

export interface ReviewThreadBatchEntry {
  readonly formatVersion: typeof REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION;
  readonly batch: ReviewThreadBatch;
}

const LineNumber = Type.Integer({ minimum: 1 });
const Side = Type.Union([Type.Literal("old"), Type.Literal("new")]);

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

const ReviewCommentSchema = Type.Object(
  {
    snapshotId: Type.String(),
    reviewUnitId: Type.String(),
    fileChangeId: Type.String(),
    side: Side,
    line: LineNumber,
    filePath: Type.String(),
    oldPath: Type.Optional(Type.String()),
    newPath: Type.Optional(Type.String()),
    oldLine: Type.Optional(LineNumber),
    newLine: Type.Optional(LineNumber),
    selectedText: Type.String(),
    nearbyContext: Type.Array(DiffLineSchema),
    body: Type.String(),
  },
  { additionalProperties: false },
);

const ReviewCommentThreadSchema = Type.Object(
  {
    id: Type.String(),
    comment: ReviewCommentSchema,
    response: Type.Optional(
      Type.Object({ body: Type.String() }, { additionalProperties: false }),
    ),
    resolved: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ReviewThreadBatchSchema = Type.Object(
  {
    id: Type.String(),
    seriesId: Type.String(),
    roundId: Type.String(),
    snapshotId: Type.String(),
    submissionMode: Type.Union([
      Type.Literal("discuss-first"),
      Type.Literal("apply-change-requests"),
    ]),
    threads: Type.Array(ReviewCommentThreadSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ReviewThreadBatchEntrySchema = Type.Object(
  {
    formatVersion: Type.Literal(REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION),
    batch: ReviewThreadBatchSchema,
  },
  { additionalProperties: false },
);

export function serializeReviewThreadBatchEntry(
  batch: ReviewThreadBatch,
): ReviewThreadBatchEntry {
  return { formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION, batch };
}

export function parseReviewThreadBatchEntry(
  data: unknown,
): ReviewThreadBatch | undefined {
  if (!Value.Check(ReviewThreadBatchEntrySchema, data)) return undefined;
  const batch = data.batch;
  if (
    batch.id.trim().length === 0 ||
    batch.seriesId.trim().length === 0 ||
    batch.roundId.trim().length === 0 ||
    batch.snapshotId.trim().length === 0
  ) {
    return undefined;
  }
  for (const [index, thread] of batch.threads.entries()) {
    if (
      thread.id !== `C${index + 1}` ||
      thread.comment.snapshotId !== batch.snapshotId ||
      thread.comment.body.trim().length === 0 ||
      (thread.response !== undefined &&
        thread.response.body.trim().length === 0) ||
      (thread.resolved && thread.response === undefined)
    ) {
      return undefined;
    }
  }
  return structuredClone(batch) as unknown as ReviewThreadBatch;
}
