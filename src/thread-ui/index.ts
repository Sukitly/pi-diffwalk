import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSnapshot, ReviewThreadBatch } from "../review/types.ts";
import { ReviewThreadComponent } from "./component.ts";
import {
  ReviewThreadUiError,
  type ReviewThreadUiInput,
  type ReviewThreadUiResult,
} from "./types.ts";

export async function openReviewThreads(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  input: ReviewThreadUiInput,
): Promise<ReviewThreadUiResult> {
  if (ctx.mode !== "tui") {
    throw new ReviewThreadUiError(
      `DiffWalk comment threads require interactive TUI mode; current mode is ${ctx.mode}.`,
    );
  }
  assertBatchMatchesSnapshot(input.batch, input.snapshot);

  return ctx.ui.custom<ReviewThreadUiResult>(
    (tui, theme, _keybindings, done) =>
      new ReviewThreadComponent({
        ...input,
        tui,
        theme,
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    },
  );
}

export function assertBatchMatchesSnapshot(
  batch: ReviewThreadBatch,
  snapshot: ReviewSnapshot,
): void {
  if (batch.snapshotId !== snapshot.id) {
    throw new ReviewThreadUiError(
      `Thread batch ${batch.id} references snapshot ${batch.snapshotId}, not ${snapshot.id}.`,
    );
  }
  if (batch.threads.length === 0 || batch.turns.length === 0) {
    throw new ReviewThreadUiError(`Thread batch ${batch.id} is empty.`);
  }
}
