declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & {
	readonly [brand]: Name;
};

export type ReviewSeriesId = Brand<string, "ReviewSeriesId">;
export type ReviewRoundId = Brand<string, "ReviewRoundId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type FileChangeId = Brand<string, "FileChangeId">;
export type HunkId = Brand<string, "HunkId">;
export type HunkFingerprint = Brand<string, "HunkFingerprint">;
export type NoticeId = Brand<string, "NoticeId">;
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

export interface TextChange {
	readonly kind: "text";
	readonly hunks: readonly DiffHunk[];
}

export interface BinaryChange {
	readonly kind: "binary";
	readonly gitBodyLines: readonly string[];
	readonly unsupportedReason: string;
}

export interface MetadataOnlyChange {
	readonly kind: "metadata-only";
	readonly gitBodyLines: readonly string[];
	readonly unsupportedReason: string;
}

export interface UnsupportedChange {
	readonly kind: "unsupported";
	readonly gitBodyLines: readonly string[];
	readonly unsupportedReason: string;
}

export interface DiffHunk {
	readonly id: HunkId;
	readonly fingerprint: HunkFingerprint;
	readonly fileChangeId: FileChangeId;
	readonly header: DiffHunkHeader;
	readonly lines: readonly DiffLine[];
}

export interface DiffHunkHeader {
	readonly raw: string;
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newStart: number;
	readonly newCount: number;
}

export type DiffLineKind =
	| "context"
	| "added"
	| "removed"
	| "no-newline-marker";

export interface DiffLine {
	readonly index: number;
	readonly kind: DiffLineKind;
	readonly raw: string;
	readonly oldLine?: number;
	readonly newLine?: number;
}

export type SnapshotNoticeKind = "cancelled-layer-change";

export interface SnapshotNotice {
	readonly id: NoticeId;
	readonly kind: SnapshotNoticeKind;
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

export interface ReviewDelta {
	readonly currentSnapshotId: SnapshotId;
	readonly baselineRoundId?: ReviewRoundId;
	readonly hunks: readonly HunkReviewRequirement[];
	readonly removedHunkFingerprints: readonly HunkFingerprint[];
}

export type HunkReviewRequirement = NeedsReviewHunk | CarriedForwardHunk;

export type NeedsReviewReason =
	| "new"
	| "changed"
	| "unresolved-comment"
	| "previously-skipped"
	| "ambiguous-match";

export interface NeedsReviewHunk {
	readonly type: "needs-review";
	readonly hunkId: HunkId;
	readonly reason: NeedsReviewReason;
	readonly previousFingerprint?: HunkFingerprint;
}

export interface CarriedForwardHunk {
	readonly type: "carried-forward";
	readonly hunkId: HunkId;
	readonly reviewedInRoundId: ReviewRoundId;
}

export interface ReviewCoverage {
	readonly snapshotId: SnapshotId;
	readonly records: readonly HunkReviewRecord[];
}

interface HunkReviewRecordBase {
	readonly hunkId: HunkId;
	readonly fingerprint: HunkFingerprint;
}

export type HunkReviewDisposition =
	| "reviewed-without-comment"
	| "commented"
	| "skipped";

export type HunkReviewRecord =
	| (HunkReviewRecordBase & {
			readonly disposition: "reviewed-without-comment";
			readonly reviewedInRoundId: ReviewRoundId;
	  })
	| (HunkReviewRecordBase & {
			readonly disposition: "commented";
			readonly commentedInRoundId: ReviewRoundId;
	  })
	| (HunkReviewRecordBase & {
			readonly disposition: "skipped";
			readonly skippedInRoundId: ReviewRoundId;
			readonly skipReason: string;
	  });
