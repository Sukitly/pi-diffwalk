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
export type ReviewThreadBatchId = Brand<string, "ReviewThreadBatchId">;
export type ReviewThreadTurnId = Brand<string, "ReviewThreadTurnId">;
export type ReviewCommentId = Brand<string, "ReviewCommentId">;
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
  /** How the reviewer handled each unit, kept for tuning routine proposals. */
  readonly units: readonly ReviewRoundUnit[];
}

/**
 * `glanced`: a folded unit accepted without expanding it. `expanded`: a
 * folded unit the reviewer opened before completing. `reviewed`: a walked
 * unit. `routineCandidate` is the reviewer saying a walked unit could have
 * been folded. `routine` records the agent's claim; `fold` records what the
 * walkthrough did with the unit and why.
 */
export interface ReviewRoundUnit {
  readonly id: ReviewUnitId;
  readonly title: string;
  readonly routine: boolean;
  readonly fold?: ReviewUnitFold;
  readonly attention?: ReviewUnitAttention;
  readonly outcome: "reviewed" | "glanced" | "expanded";
  readonly routineCandidate: boolean;
  readonly commented: boolean;
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
  readonly disposition: "pending" | "reviewed" | "glanced";
  /** The reviewer expanded this routine unit at least once. */
  readonly expanded?: true;
  /** The reviewer marked this walked unit as one that could have been routine. */
  readonly routineCandidate?: true;
}

export interface ReviewDelta {
  readonly currentSnapshotId: SnapshotId;
  readonly baselineRoundId?: ReviewRoundId;
  readonly lines: readonly ChangedLineRequirement[];
  /** Changed lines present in the baseline round that no longer exist. */
  readonly removedLineCount: number;
}

export type ChangedLineRequirement =
  | NeedsReviewLine
  | CarriedForwardLine
  | ExcludedLine;

export type NeedsReviewReason =
  | "new"
  | "unresolved-comment"
  | "previously-skipped"
  | "previously-excluded";

export interface NeedsReviewLine extends ChangedLineRef {
  readonly type: "needs-review";
  readonly reason: NeedsReviewReason;
}

export interface CarriedForwardLine extends ChangedLineRef {
  readonly type: "carried-forward";
  readonly reviewedInRoundId: ReviewRoundId;
}

/**
 * Why a mechanical rule removed a changed line from the review. Exclusion is
 * recomputed for every round from the current snapshot and never carried
 * forward, so a rule that stops matching returns the line to review.
 */
export type ExclusionReason =
  | "excluded-path"
  | "generated-attribute"
  | "whitespace-only";

export interface ExcludedLine extends ChangedLineRef {
  readonly type: "excluded";
  readonly reason: ExclusionReason;
  /** The matching pattern for `excluded-path`; absent for the other reasons. */
  readonly pattern?: string;
}

export type ChangedLineDisposition =
  | "reviewed-without-comment"
  | "commented"
  | "skipped"
  | "excluded";

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
    })
  | (ChangedLineRecordBase & {
      readonly disposition: "excluded";
      readonly excludedInRoundId: ReviewRoundId;
      readonly exclusionReason: ExclusionReason;
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

const ReviewCheckAnchorCandidateSchema = Type.Object(
  {
    path: Type.String({
      description: "Path of the changed file the question is about",
    }),
    side: Type.Union([Type.Literal("old"), Type.Literal("new")], {
      description: "old for a removed line, new for an added line",
    }),
    line: Type.Integer({
      minimum: 1,
      description: "1-based line number on that side",
    }),
  },
  {
    additionalProperties: false,
    description:
      "The changed line this question is about. It must be inside this unit's spans. Omit the anchor only for a question about the unit as a whole.",
  },
);

const ReviewCheckCandidateSchema = Type.Object(
  {
    question: Type.String({
      description:
        "One question naming a specific way this change could be wrong",
    }),
    anchor: Type.Optional(ReviewCheckAnchorCandidateSchema),
  },
  { additionalProperties: false },
);

const ReviewUnitRoutineCandidateSchema = Type.Object(
  {
    reference: Type.String({
      description:
        "Existing code this unit mirrors, as a repository path optionally followed by :start-end line numbers",
    }),
    reason: Type.String({
      description:
        "One sentence stating what makes the unit a repetition of the reference",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Present only when the unit repeats an existing pattern and needs no judgment. The walkthrough folds it; the reviewer can expand it or override the claim.",
  },
);

const ReviewUnitCandidateSchema = Type.Object(
  {
    title: Type.String({
      description: "Concise phrase naming this review unit",
    }),
    whyHere: Type.String({
      description:
        "One concise sentence explaining why this unit belongs here in the review order",
    }),
    context: Type.String({
      description:
        "One to three concise sentences covering only the call path, contract, or invariant needed for this unit",
    }),
    changeSummary: Type.String({
      description:
        "One or two direct sentences describing the behavior change without patch text",
    }),
    reviewFocus: Type.Array(ReviewCheckCandidateSchema, {
      description:
        "Distinct questions naming specific ways this change could be wrong, each anchored to the changed line it concerns. Give as many as the unit genuinely needs and none when it needs none; never invent one to fill the field",
      maxItems: 5,
    }),
    spans: Type.Array(ReviewSpanCandidateSchema, {
      description:
        "File regions covered by this unit; a unit may span several files",
      minItems: 1,
    }),
    routine: Type.Optional(ReviewUnitRoutineCandidateSchema),
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

/**
 * A route is assembled one call at a time, so that a rejected unit or skip
 * costs one item of work instead of the whole route. Only one review can be
 * pending, so the tools carry no snapshot identifier: the pending snapshot is
 * the one being routed.
 */
export const ReviewUnitCandidateToolSchema = ReviewUnitCandidateSchema;

export const ReviewSkipCandidateToolSchema = ReviewRouteSkipCandidateSchema;

export const ReviewOpenToolSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type ReviewUnitCandidate = Type.Static<typeof ReviewUnitCandidateSchema>;

export type ReviewSkipCandidate = Type.Static<
  typeof ReviewRouteSkipCandidateSchema
>;

export type ReviewSpanCandidate = Type.Static<typeof ReviewSpanCandidateSchema>;

export type ReviewCheckCandidate = Type.Static<
  typeof ReviewCheckCandidateSchema
>;

export interface ReviewCheckAnchor {
  readonly fileChangeId: FileChangeId;
  readonly path: string;
  readonly side: ChangeSide;
  readonly line: number;
}

export interface ReviewCheck {
  readonly question: string;
  readonly anchor?: ReviewCheckAnchor;
}

export interface ReviewRoute {
  readonly [brand]: "ValidatedReviewRoute";
  readonly snapshotId: SnapshotId;
  readonly units: readonly ReviewUnit[];
  readonly skippedSpans: readonly ReviewRouteSkip[];
}

export interface ReviewUnitRoutine {
  readonly reference: string;
  readonly reason: string;
}

/**
 * Why a unit is folded in the walkthrough. `agent`: the agent's routine
 * claim was taken at its word. `typesafe`: a decision model judged the
 * unit's surface features and the fold policy accepted them; `features`
 * keeps what it saw so folds can be tuned against reviewer outcomes.
 */
export type ReviewUnitFold =
  | {
      readonly source: "agent";
      readonly reasons: readonly string[];
    }
  | {
      readonly source: "typesafe";
      readonly reasons: readonly string[];
      readonly features: ReviewUnitFeatures;
    };

/**
 * The judge's verdict on a unit. Folding is the default; `attention`
 * records why a unit earned the reviewer's time, so the route shows which
 * units matter and that the judge ran even when every unit folds.
 */
export type ReviewUnitVerdict =
  | { readonly outcome: "folded"; readonly fold: ReviewUnitFold }
  | {
      readonly outcome: "attention";
      readonly source: "typesafe";
      readonly reasons: readonly string[];
      /** Absent when an open comment demanded attention before the model was asked. */
      readonly features?: ReviewUnitFeatures;
    };

export type ReviewUnitAttention = Extract<
  ReviewUnitVerdict,
  { outcome: "attention" }
>;

/** Surface features of one unit as a decision model reports them. */
export interface ReviewUnitFeatures {
  readonly changesBehavior: number;
  readonly newControlFlow: number;
  readonly touchesBoundary: {
    readonly choice: ReviewUnitBoundary;
    readonly confidence: number;
  };
  readonly kind: {
    readonly choice: ReviewUnitKind;
    readonly confidence: number;
  };
  /** Present only when the agent named a reference. */
  readonly mirrorsReference?: number;
}

export type ReviewUnitBoundary =
  | "none"
  | "public-api"
  | "persisted-format"
  | "authorization"
  | "money"
  | "external-process";

export type ReviewUnitKind =
  | "behavior"
  | "interface"
  | "test"
  | "config"
  | "docs"
  | "refactor"
  | "generated";

export interface ReviewUnit {
  readonly id: ReviewUnitId;
  readonly title: string;
  readonly whyHere: string;
  readonly context: string;
  readonly changeSummary: string;
  readonly reviewFocus: readonly ReviewCheck[];
  readonly spans: readonly ResolvedSpan[];
  readonly routine?: ReviewUnitRoutine;
  readonly fold?: ReviewUnitFold;
  /** Present when a decision model judged the unit as needing the reviewer. */
  readonly attention?: ReviewUnitAttention;
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

export interface AgentReviewResponse {
  readonly body: string;
}

export type ReviewThreadAnchor = Omit<ReviewComment, "body">;

export interface ReviewCommentThread {
  readonly id: ReviewCommentId;
  readonly anchor: ReviewThreadAnchor;
  readonly resolved: boolean;
  readonly draftReply?: string;
}

export interface ReviewThreadTurnItem {
  readonly threadId: ReviewCommentId;
  readonly reviewerBody: string;
  readonly agentResponse?: AgentReviewResponse;
}

export interface ReviewThreadTurn {
  readonly id: ReviewThreadTurnId;
  readonly sequence: number;
  readonly submissionMode: ReviewSubmissionMode;
  readonly items: readonly ReviewThreadTurnItem[];
}

export interface ReviewThreadBatch {
  readonly id: ReviewThreadBatchId;
  readonly seriesId: ReviewSeriesId;
  readonly roundId: ReviewRoundId;
  readonly snapshotId: SnapshotId;
  readonly threads: readonly ReviewCommentThread[];
  readonly turns: readonly ReviewThreadTurn[];
}

export interface SubmittedGuidedReviewResult {
  readonly status: "submitted";
  readonly snapshotId: SnapshotId;
  readonly submissionMode: ReviewSubmissionMode;
  readonly comments: readonly ReviewComment[];
  readonly commentBatchId?: ReviewThreadBatchId;
  readonly commentTurnId?: ReviewThreadTurnId;
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
