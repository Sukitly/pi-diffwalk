import type {
  FileChange,
  ReviewCommentId,
  ReviewCommentThread,
  ReviewSnapshot,
  ReviewThreadBatch,
  ReviewThreadTurnId,
} from "../review/types.ts";
import type { UiTheme } from "../ui/theme.ts";

export interface ReviewThreadUiInput {
  readonly snapshot: ReviewSnapshot;
  readonly batch: ReviewThreadBatch;
  readonly onBatchChange: (batch: ReviewThreadBatch) => void;
}

export type ReviewThreadUiResult =
  | {
      readonly status: "closed";
      readonly batch: ReviewThreadBatch;
    }
  | {
      readonly status: "follow-up-submitted";
      readonly batch: ReviewThreadBatch;
      readonly turnId: ReviewThreadTurnId;
    };

export type ThreadUiTheme = UiTheme;

export type ThreadScreen = "threads" | "reply-editor" | "submission";

export interface ThreadRegion {
  readonly change: FileChange;
  start: number;
  end: number;
  readonly threads: ReviewCommentThread[];
}

export interface RenderedThreadRow {
  readonly text: string;
  readonly commentId?: ReviewCommentId;
}

export class ReviewThreadUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewThreadUiError";
  }
}
