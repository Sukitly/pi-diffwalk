import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  routeAsCandidate,
  validateReviewRoute,
} from "../review/route-validation.ts";
import type {
  GuidedReviewResult,
  InProgressReview,
  SubmittedGuidedReviewResult,
} from "../review/types.ts";
import { GuidedReviewComponent } from "./component.ts";
import {
  GuidedReviewUiInvariantError,
  GuidedReviewUiUnavailableError,
} from "./errors.ts";

export interface GuidedReviewUiInput {
  readonly review: InProgressReview;
  readonly onReviewChange: (review: InProgressReview) => void;
  readonly onSubmit: (
    review: InProgressReview,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
}

export async function openGuidedReview(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  input: GuidedReviewUiInput,
): Promise<GuidedReviewResult> {
  if (ctx.mode !== "tui") {
    throw new GuidedReviewUiUnavailableError(ctx.mode);
  }

  const review = input.review;
  const attachedRoute = review.route;
  if (review.lifecycle !== "ready" || attachedRoute === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review ${review.id} is not ready for a walkthrough; lifecycle is ${review.lifecycle}.`,
    );
  }
  const route = validateReviewRoute(
    review.snapshot,
    review.delta,
    routeAsCandidate(attachedRoute),
  );
  const progressUnitIds = new Set(
    review.unitProgress.map((progress) => progress.reviewUnitId),
  );
  for (const unit of route.units) {
    if (!progressUnitIds.has(unit.id)) {
      throw new GuidedReviewUiInvariantError(
        `Review ${review.id} has no unit progress for route unit ${unit.id}.`,
      );
    }
  }

  return ctx.ui.custom<GuidedReviewResult>(
    (tui, theme, keybindings, done) =>
      new GuidedReviewComponent({
        tui,
        theme,
        keybindings,
        review,
        route,
        onReviewChange: input.onReviewChange,
        onSubmit: input.onSubmit,
        onComplete: done,
        onPause: () =>
          done({ status: "paused", snapshotId: review.snapshot.id }),
        onDiscard: () =>
          done({ status: "discarded", snapshotId: review.snapshot.id }),
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
