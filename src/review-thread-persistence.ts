import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ReviewCommentId, ReviewThreadBatch } from "./types.ts";

export const DIFFWALK_THREAD_BATCH_ENTRY_TYPE = "diffwalk-thread-batch";
export const REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION = 1;

export interface ReviewThreadBatchEntry {
  readonly formatVersion: typeof REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION;
  readonly batch: ReviewThreadBatch;
}

const LineNumber = Type.Integer({ minimum: 1 });
const Side = Type.Union([Type.Literal("old"), Type.Literal("new")]);
const SubmissionMode = Type.Union([
  Type.Literal("discuss-first"),
  Type.Literal("apply-change-requests"),
]);

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

const ReviewThreadAnchorSchema = Type.Object(
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
  },
  { additionalProperties: false },
);

const AgentResponseSchema = Type.Object(
  { body: Type.String() },
  { additionalProperties: false },
);

const ReviewCommentThreadSchema = Type.Object(
  {
    id: Type.String(),
    anchor: ReviewThreadAnchorSchema,
    resolved: Type.Boolean(),
    draftReply: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ReviewThreadTurnItemSchema = Type.Object(
  {
    threadId: Type.String(),
    reviewerBody: Type.String(),
    agentResponse: Type.Optional(AgentResponseSchema),
  },
  { additionalProperties: false },
);

const ReviewThreadTurnSchema = Type.Object(
  {
    id: Type.String(),
    sequence: Type.Integer({ minimum: 1 }),
    submissionMode: SubmissionMode,
    items: Type.Array(ReviewThreadTurnItemSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const ReviewThreadBatchSchema = Type.Object(
  {
    id: Type.String(),
    seriesId: Type.String(),
    roundId: Type.String(),
    snapshotId: Type.String(),
    threads: Type.Array(ReviewCommentThreadSchema, { minItems: 1 }),
    turns: Type.Array(ReviewThreadTurnSchema, { minItems: 1 }),
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

type StoredReviewThreadBatch = Static<typeof ReviewThreadBatchSchema>;

export function serializeReviewThreadBatchEntry(
  batch: ReviewThreadBatch,
): ReviewThreadBatchEntry {
  return { formatVersion: REVIEW_THREAD_BATCH_ENTRY_FORMAT_VERSION, batch };
}

export function parseReviewThreadBatchEntry(
  data: unknown,
): ReviewThreadBatch | undefined {
  if (!Value.Check(ReviewThreadBatchEntrySchema, data)) return undefined;
  return parseCurrentBatch(data.batch);
}

function parseCurrentBatch(
  stored: StoredReviewThreadBatch,
): ReviewThreadBatch | undefined {
  if (!validBatchIdentity(stored)) return undefined;
  const knownIds = new Set<string>();
  for (const [index, thread] of stored.threads.entries()) {
    if (
      thread.id !== `C${index + 1}` ||
      knownIds.has(thread.id) ||
      thread.anchor.snapshotId !== stored.snapshotId ||
      (thread.draftReply !== undefined &&
        (thread.draftReply.trim().length === 0 || thread.resolved))
    ) {
      return undefined;
    }
    knownIds.add(thread.id);
  }

  let pendingTurnFound = false;
  for (const [index, turn] of stored.turns.entries()) {
    if (turn.id !== `T${index + 1}` || turn.sequence !== index + 1) {
      return undefined;
    }
    const seen = new Set<string>();
    let answered = 0;
    for (const item of turn.items) {
      if (
        !knownIds.has(item.threadId) ||
        seen.has(item.threadId) ||
        item.reviewerBody.trim().length === 0 ||
        (item.agentResponse !== undefined &&
          item.agentResponse.body.trim().length === 0)
      ) {
        return undefined;
      }
      seen.add(item.threadId);
      if (item.agentResponse !== undefined) answered += 1;
    }
    if (index === 0 && seen.size !== stored.threads.length) return undefined;
    if (answered !== 0 && answered !== turn.items.length) return undefined;
    if (answered === 0) {
      if (pendingTurnFound || index !== stored.turns.length - 1)
        return undefined;
      pendingTurnFound = true;
    }
  }

  const batch = structuredClone(stored) as unknown as ReviewThreadBatch;
  for (const thread of batch.threads) {
    if (thread.resolved && !latestThreadExchangeAnswered(batch, thread.id)) {
      return undefined;
    }
  }
  return batch;
}

function validBatchIdentity(batch: {
  readonly id: string;
  readonly seriesId: string;
  readonly roundId: string;
  readonly snapshotId: string;
}): boolean {
  return (
    batch.id.trim().length > 0 &&
    batch.seriesId.trim().length > 0 &&
    batch.roundId.trim().length > 0 &&
    batch.snapshotId.trim().length > 0
  );
}

function latestThreadExchangeAnswered(
  batch: ReviewThreadBatch,
  threadId: ReviewCommentId,
): boolean {
  for (let index = batch.turns.length - 1; index >= 0; index -= 1) {
    const item = batch.turns[index]?.items.find(
      (candidate) => candidate.threadId === threadId,
    );
    if (item !== undefined) return item.agentResponse !== undefined;
  }
  return false;
}
