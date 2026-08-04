import { Type } from "typebox";

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type ReviewSeriesId = Brand<string, "ReviewSeriesId">;
export type ReviewRoundId = Brand<string, "ReviewRoundId">;
export type InProgressReviewId = Brand<string, "InProgressReviewId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type FileChangeId = Brand<string, "FileChangeId">;
export type NoticeId = Brand<string, "NoticeId">;
export type ReviewUnitId = Brand<string, "ReviewUnitId">;
export type GitObjectId = Brand<string, "GitObjectId">;
export type StateFingerprint = Brand<string, "StateFingerprint">;

export interface ReviewSnapshot {
  readonly id: SnapshotId;
  readonly repositoryRoot: string;
  readonly comparison: ReviewComparison;
  readonly repositoryState: RepositoryState;
  readonly changes: readonly FileChange[];
  readonly notices: readonly SnapshotNotice[];
}

export interface ReviewComparison {
  readonly targetRef: string;
  readonly targetOid: GitObjectId;
  readonly sourceHeadOid: GitObjectId;
  readonly mergeBaseOid: GitObjectId;
  /** Branch HEAD pointed at when the snapshot was captured; undefined when detached. */
  readonly sourceBranch?: string;
}

export interface RepositoryState {
  readonly headOid: GitObjectId;
  readonly stagedFingerprint: StateFingerprint;
  readonly unstagedFingerprint: StateFingerprint;
  readonly untrackedFingerprint: StateFingerprint;
}

export type FileChangeSource = "tracked" | "untracked";

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "mode-changed"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface FileChange {
  readonly id: FileChangeId;
  readonly source: FileChangeSource;
  readonly status: FileChangeStatus;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly gitHeaderLines: readonly string[];
  readonly content: FileChangeContent;
}

export type FileChangeContent =
  | TextChange
  | BinaryChange
  | MetadataOnlyChange
  | UnsupportedChange;

/**
 * Frozen text content of one changed file.
 *
 * `lines` covers the entire file, not only the regions Git chose to emit as
 * hunks. A review span may address any line, so the snapshot must be able to
 * render and classify any line. The array is also the old-to-new line number
 * mapping and the source of the changed-line set.
 */
export interface TextChange {
  readonly type: "text";
  readonly lines: readonly DiffLine[];
  readonly oldLineCount: number;
  readonly newLineCount: number;
  readonly oldNoTrailingNewline: boolean;
  readonly newNoTrailingNewline: boolean;
  /** Spans derived from Git hunk boundaries, offered to the agent as a starting point. */
  readonly suggestedSpans: readonly ReviewSpan[];
}

export interface BinaryChange {
  readonly type: "binary";
  readonly gitBodyLines: readonly string[];
  readonly unsupportedReason: string;
}

export interface MetadataOnlyChange {
  readonly type: "metadata-only";
  readonly gitBodyLines: readonly string[];
  readonly unsupportedReason: string;
}

export interface UnsupportedChange {
  readonly type: "unsupported";
  readonly gitBodyLines: readonly string[];
  readonly unsupportedReason: string;
}

export type DiffLineType = "context" | "added" | "removed";

/** One line of one file in the frozen snapshot, addressed on the side it exists. */
export interface DiffLine {
  readonly type: DiffLineType;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

/** Added lines exist only on the new side; removed lines only on the old side. */
export type ChangeSide = "old" | "new";

/** Identity of one changed line. This is the atom of review coverage. */
export interface ChangedLineRef {
  readonly fileChangeId: FileChangeId;
  readonly side: ChangeSide;
  readonly line: number;
}

/** A region of one file, proposed by the agent. Line numbers are 1-based and inclusive. */
export interface ReviewSpan {
  readonly path: string;
  readonly oldStart?: number;
  readonly oldEnd?: number;
  readonly newStart?: number;
  readonly newEnd?: number;
}

/** A span whose path has been resolved to a file in the frozen snapshot. */
export interface ResolvedSpan extends ReviewSpan {
  readonly fileChangeId: FileChangeId;
}

export type SnapshotNoticeType = "cancelled-layer-change";

export interface SnapshotNotice {
  readonly id: NoticeId;
  readonly type: SnapshotNoticeType;
  readonly fileChangeId?: FileChangeId;
  readonly filePath?: string;
  readonly message: string;
}

export interface ReviewSeries {
  readonly id: ReviewSeriesId;
  readonly repositoryRoot: string;
  readonly sourceBranch: string;
  readonly targetRef: string;
  readonly rounds: readonly ReviewRound[];
}

export interface ReviewRound {
  readonly id: ReviewRoundId;
  readonly seriesId: ReviewSeriesId;
  readonly sequence: number;
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly coverage: ReviewCoverage;
}

export type InProgressReviewLifecycle =
  | "preparing-route"
  | "ready"
  | "submitted"
  | "discarded";

export interface InProgressReview {
  readonly id: InProgressReviewId;
  readonly seriesId: ReviewSeriesId;
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly route?: ReviewRoute;
  readonly unitProgress: readonly ReviewUnitProgress[];
  readonly comments: readonly ReviewComment[];
  readonly submissionMode: ReviewSubmissionMode;
  readonly lifecycle: InProgressReviewLifecycle;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewUnitProgress {
  readonly reviewUnitId: ReviewUnitId;
  readonly disposition: "pending" | "reviewed";
}

export interface ReviewDelta {
  readonly currentSnapshotId: SnapshotId;
  readonly baselineRoundId?: ReviewRoundId;
  readonly lines: readonly ChangedLineRequirement[];
  /** Changed lines present in the baseline round that no longer exist. */
  readonly removedLineCount: number;
}

export type ChangedLineRequirement = NeedsReviewLine | CarriedForwardLine;

export type NeedsReviewReason =
  | "new"
  | "unresolved-comment"
  | "previously-skipped";

export interface NeedsReviewLine extends ChangedLineRef {
  readonly type: "needs-review";
  readonly reason: NeedsReviewReason;
}

export interface CarriedForwardLine extends ChangedLineRef {
  readonly type: "carried-forward";
  readonly reviewedInRoundId: ReviewRoundId;
}

export type ChangedLineDisposition =
  | "reviewed-without-comment"
  | "commented"
  | "skipped";

interface ChangedLineRecordBase {
  readonly side: ChangeSide;
  readonly line: number;
  readonly text: string;
}

export type ChangedLineRecord =
  | (ChangedLineRecordBase & {
      readonly disposition: "reviewed-without-comment";
      readonly reviewedInRoundId: ReviewRoundId;
    })
  | (ChangedLineRecordBase & {
      readonly disposition: "commented";
      readonly commentedInRoundId: ReviewRoundId;
    })
  | (ChangedLineRecordBase & {
      readonly disposition: "skipped";
      readonly skippedInRoundId: ReviewRoundId;
      readonly skipReason: string;
    });

/**
 * Coverage is grouped by file and keyed by path rather than by file change ID,
 * because file change IDs are snapshot-scoped while a review series must match
 * the same file across rounds.
 */
export interface FileCoverage {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly lines: readonly ChangedLineRecord[];
}

export interface ReviewCoverage {
  readonly snapshotId: SnapshotId;
  readonly files: readonly FileCoverage[];
}

const ReviewSpanCandidateSchema = Type.Object(
  {
    path: Type.String({
      description: "Path of a changed file in the frozen snapshot",
    }),
    oldStart: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "First line of the region in the old file, 1-based inclusive",
      }),
    ),
    oldEnd: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Last line of the region in the old file, 1-based inclusive",
      }),
    ),
    newStart: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "First line of the region in the new file, 1-based inclusive",
      }),
    ),
    newEnd: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Last line of the region in the new file, 1-based inclusive",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "A region of one file. Use the new side for added lines and the old side for removed lines; set both when a region contains each.",
  },
);

const ReviewUnitCandidateSchema = Type.Object(
  {
    title: Type.String({ description: "Short title for this review unit" }),
    whyHere: Type.String({
      description: "Why this unit belongs at this point in the review order",
    }),
    context: Type.String({
      description:
        "Call path, contract, or invariant needed to review this unit",
    }),
    changeSummary: Type.String({
      description: "Direct description of the change represented by this unit",
    }),
    reviewFocus: Type.Array(Type.String(), {
      description: "Concrete questions for the human reviewer",
      minItems: 1,
    }),
    spans: Type.Array(ReviewSpanCandidateSchema, {
      description:
        "File regions covered by this unit; a unit may span several files",
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

const ReviewRouteSkipCandidateSchema = Type.Object(
  {
    span: ReviewSpanCandidateSchema,
    reason: Type.String({
      description:
        "Visible reason why the changed lines in this region are excluded from the walkthrough",
    }),
  },
  { additionalProperties: false },
);

export const ReviewRouteCandidateSchema = Type.Object(
  {
    snapshotId: Type.String({
      description: "Identifier of the frozen snapshot being routed",
    }),
    units: Type.Array(ReviewUnitCandidateSchema, {
      description: "Semantic review units in walkthrough order",
    }),
    skippedSpans: Type.Array(ReviewRouteSkipCandidateSchema, {
      description:
        "Regions whose changed lines are explicitly skipped with visible reasons; lines with unresolved comments cannot be skipped",
    }),
  },
  { additionalProperties: false },
);

export type ReviewRouteCandidate = Type.Static<
  typeof ReviewRouteCandidateSchema
>;

export type ReviewSpanCandidate = Type.Static<typeof ReviewSpanCandidateSchema>;

export interface ReviewRoute {
  readonly [brand]: "ValidatedReviewRoute";
  readonly snapshotId: SnapshotId;
  readonly units: readonly ReviewUnit[];
  readonly skippedSpans: readonly ReviewRouteSkip[];
}

export interface ReviewUnit {
  readonly id: ReviewUnitId;
  readonly title: string;
  readonly whyHere: string;
  readonly context: string;
  readonly changeSummary: string;
  readonly reviewFocus: readonly string[];
  readonly spans: readonly ResolvedSpan[];
}

export interface ReviewRouteSkip {
  readonly span: ResolvedSpan;
  readonly reason: string;
}

export interface ReviewComment {
  readonly snapshotId: SnapshotId;
  readonly reviewUnitId: ReviewUnitId;
  readonly fileChangeId: FileChangeId;
  readonly side: ChangeSide;
  readonly line: number;
  readonly filePath: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly selectedText: string;
  readonly nearbyContext: readonly DiffLine[];
  readonly body: string;
}

export type ReviewSubmissionMode = "discuss-first" | "apply-change-requests";

export interface SubmittedGuidedReviewResult {
  readonly status: "submitted";
  readonly snapshotId: SnapshotId;
  readonly submissionMode: ReviewSubmissionMode;
  readonly comments: readonly ReviewComment[];
}

export interface PausedGuidedReviewResult {
  readonly status: "paused";
  readonly snapshotId: SnapshotId;
}

export interface DiscardedGuidedReviewResult {
  readonly status: "discarded";
  readonly snapshotId: SnapshotId;
}

export type GuidedReviewResult =
  | SubmittedGuidedReviewResult
  | PausedGuidedReviewResult
  | DiscardedGuidedReviewResult;
