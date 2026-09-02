import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import type { ReviewCommentTarget } from "../review/comments.ts";
import type {
  DiffLine,
  FileChange,
  ResolvedSpan,
  ReviewUnit,
} from "../review/types.ts";
import type { UiTheme } from "../ui/theme.ts";

export type ReviewUiTheme = UiTheme & Pick<Theme, "inverse">;

export type ReviewUiKeybindings = Pick<KeybindingsManager, "matches">;

export type ReviewScreen =
  | "walkthrough"
  | "comment-editor"
  | "explanation"
  | "inventory"
  | "inventory-diff"
  | "summary"
  | "help"
  | "cancel-confirmation";

export type SubmissionStatus =
  | "not-checked"
  | "checking"
  | "repository-drifted"
  | "verification-failed";

export type FeedbackType = "info" | "warning";

export interface TransientFeedback {
  readonly type: FeedbackType;
  readonly message: string;
}

export interface SubmissionFailure {
  readonly type: "repository-drifted" | "verification-failed";
  readonly error: unknown;
}

/** One file region of a review unit, sliced out of the frozen file. */
export interface SpanView {
  readonly change: FileChange;
  readonly span: ResolvedSpan;
  readonly lines: readonly DiffLine[];
}

export type ChangedLineDisplayOwnership =
  | {
      readonly type: "unit";
      readonly reviewUnitId: ReviewUnit["id"];
      readonly unitTitle: string;
      readonly spanIndex: number;
    }
  | {
      readonly type: "skipped";
      readonly reason: string;
    }
  | {
      readonly type: "carried-forward";
    };

export type DisplayOmissionReason =
  | { readonly type: "distant" }
  | {
      readonly type: "gap";
      readonly carriedForward: number;
      readonly skipped: number;
      readonly otherUnit: number;
      readonly shownLater: number;
    }
  | { readonly type: "route-jump" }
  | { readonly type: "carried-forward" }
  | { readonly type: "skipped"; readonly reason: string }
  | { readonly type: "other-unit"; readonly unitTitle: string }
  | { readonly type: "shown-earlier" }
  | { readonly type: "shown-later" };

export interface PlannedDiffLine {
  readonly type: "line";
  readonly line: DiffLine;
  readonly role: "owned" | "context" | "external";
  readonly externalDetail?: string;
}

export interface PlannedDiffOmission {
  readonly type: "omission";
  readonly count: number;
  readonly reason: DisplayOmissionReason;
}

export type PlannedDiffItem = PlannedDiffLine | PlannedDiffOmission;

export interface UnitDisplayBlock {
  readonly change: FileChange;
  readonly items: readonly PlannedDiffItem[];
}

export interface UnitView {
  readonly unit: ReviewUnit;
  readonly displayBlocks: readonly UnitDisplayBlock[];
  readonly targets: readonly ReviewCommentTarget[];
}

export type InventoryEntry =
  | {
      readonly type: "file";
      readonly title: string;
      readonly detail: string;
      readonly change: FileChange;
      readonly regions: readonly DiffLine[][];
    }
  | {
      readonly type: "metadata-only" | "binary" | "unsupported" | "notice";
      readonly title: string;
      readonly detail: string;
    };

export interface RenderedRow {
  readonly text: string;
  readonly targetKey?: string;
  readonly inventoryIndex?: number;
  readonly displayBlockIndex?: number;
  readonly isBlockHeader?: boolean;
}

export interface DiffViewport {
  readonly offset: number;
  readonly contentHeight: number;
  readonly pinnedBlockIndex?: number;
}
