import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export class GuidedReviewUiUnavailableError extends Error {
  constructor(mode: ExtensionContext["mode"]) {
    super(
      `Guided review requires interactive TUI mode; current mode is ${mode}.`,
    );
    this.name = "GuidedReviewUiUnavailableError";
  }
}

export class GuidedReviewUiInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidedReviewUiInvariantError";
  }
}
