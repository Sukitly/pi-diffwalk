import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewThreadComponent } from "./component.ts";
import {
  assertBatchMatchesSnapshot,
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
