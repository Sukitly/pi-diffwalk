import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import type {
  KeybindingsManager as CodingKeybindingsManager,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { ReviewSnapshotDriftError } from "../../src/git/errors.ts";
import { InProgressReviewError } from "../../src/review/in-progress.ts";
import {
  ReviewRouteValidationError,
  validateReviewRoute,
} from "../../src/review/route-validation.ts";
import type {
  InProgressReview,
  ReviewDelta,
  ReviewRouteCandidate,
} from "../../src/review/types.ts";
import { GuidedReviewUiUnavailableError } from "../../src/review-ui/errors.ts";
import { openGuidedReview } from "../../src/review-ui/index.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import {
  CARRIED_PATH,
  createHarness,
  createKeybindings,
  FakeTerminal,
  forgeRoute,
  makeReview,
  makeReviewWithRoute,
  makeUiFixture,
  openWithSubmissionFailure,
  plainTheme,
  press,
  renderText,
  unusedSubmit,
} from "./harness.ts";

test("aborts pending verification and ignores its late result", async () => {
  let resolveVerification: (() => void) | undefined;
  let verifierSignal: AbortSignal | undefined;
  const harness = createHarness(80, 24, makeUiFixture(), {
    verifier: async (_snapshot, signal) => {
      verifierSignal = signal;
      await new Promise<void>((resolve) => {
        resolveVerification = resolve;
      });
    },
  });
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "n", "n", "\r");
  assert.match(renderText(harness), /Snapshot check in progress/);
  assert.match(renderText(harness), /Checking the frozen snapshot/);

  press(harness.component, "\u001b");
  assert.equal(verifierSignal?.aborted, true);
  assert.match(renderText(harness), /Leave DiffWalk/);
  press(harness.component, "\u001b");
  assert.match(renderText(harness), /verification was cancelled/);

  resolveVerification?.();
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 0);
  assert.equal(harness.state.review.comments[0]?.body, "Draft");
});

test("pauses explicitly without discarding drafts", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "c", "D", "r", "a", "f", "t", "\r", "\u001b");

  assert.match(renderText(harness), /Leave DiffWalk/);
  assert.match(renderText(harness), /Pause to keep 1 draft comment/);
  press(harness.component, "\u001b");
  assert.equal(harness.cancellations.count, 0);
  assert.match(renderText(harness), /DiffWalk \/ Review/);

  press(harness.component, "\u001b", "\r");
  assert.equal(harness.cancellations.count, 1);
});

test("supports an empty walkthrough when no hunk requires review", async () => {
  const snapshot = makeSnapshot("snapshot-empty-ui", []);
  const delta: ReviewDelta = {
    currentSnapshotId: snapshot.id,
    lines: [],
    removedLineCount: 0,
  };
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(80, 12, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  assert.match(renderText(harness), /No review units were planned/);
  press(harness.component, "e");
  assert.match(renderText(harness), /No unit details are available/);
  assert.doesNotMatch(renderText(harness), /agent explanation/i);
  press(harness.component, "e");
  press(harness.component, "s", "\r");
  assert.deepEqual(harness.submittedModes, ["discuss-first"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("validates missing route coverage before opening custom UI", async () => {
  const fixture = makeUiFixture();
  const candidate = structuredClone(fixture.routeCandidate);
  candidate.units.splice(1, 1);
  const review = makeReviewWithRoute(fixture, forgeRoute(fixture, candidate));
  let customCalls = 0;
  const custom: ExtensionContext["ui"]["custom"] = async () => {
    customCalls += 1;
    throw new Error("custom UI must not open");
  };

  await assert.rejects(
    openGuidedReview(
      { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
      { review, onReviewChange: () => {}, onSubmit: unusedSubmit },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRouteValidationError);
      assert.ok(
        error.issues.some((issue) => issue.code === "missing-coverage"),
      );
      return true;
    },
  );
  assert.equal(customCalls, 0);
});

test("rejects carried-forward route references before opening custom UI", async () => {
  const fixture = makeUiFixture();
  const candidate = structuredClone(fixture.routeCandidate);
  const firstUnit = candidate.units[0];
  assert.ok(firstUnit);
  firstUnit.spans.push(span(CARRIED_PATH, { new: [2, 2] }));
  const review = makeReviewWithRoute(fixture, forgeRoute(fixture, candidate));
  let customCalls = 0;
  const custom: ExtensionContext["ui"]["custom"] = async () => {
    customCalls += 1;
    throw new Error("custom UI must not open");
  };

  await assert.rejects(
    openGuidedReview(
      { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
      { review, onReviewChange: () => {}, onSubmit: unusedSubmit },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewRouteValidationError);
      assert.ok(
        error.issues.some(
          (issue) => issue.code === "carried-forward-reference",
        ),
      );
      return true;
    },
  );
  assert.equal(customCalls, 0);
});

test("opens a full-screen overlay and submits through one domain pipeline", async () => {
  const fixture = makeUiFixture();
  const terminal = new FakeTerminal(80, 24);
  const tui = new TuiMainScreen(terminal, false);
  let submittedReview: InProgressReview | undefined;
  let submittedSignal: AbortSignal | undefined;
  let customOptions: Parameters<ExtensionContext["ui"]["custom"]>[1];
  const custom: ExtensionContext["ui"]["custom"] = async <Result>(
    factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
    options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
  ): Promise<Result> => {
    customOptions = options;
    return new Promise<Result>((resolve, reject) => {
      void Promise.resolve(
        factory(
          tui,
          plainTheme as Theme,
          createKeybindings() as unknown as CodingKeybindingsManager,
          (result: unknown) => resolve(result as Result),
        ),
      ).then((component) => {
        tui.addChild(component);
        tui.setFocus(component);
        component.handleInput?.("n");
        component.handleInput?.("n");
        component.handleInput?.("\r");
      }, reject);
    });
  };

  const result = await openGuidedReview(
    { mode: "tui", ui: { custom } as ExtensionContext["ui"] },
    {
      review: makeReview(fixture),
      onReviewChange: () => {},
      onSubmit: async (review, signal) => {
        submittedReview = review;
        submittedSignal = signal;
        return {
          status: "submitted",
          snapshotId: review.snapshot.id,
          submissionMode: review.submissionMode,
          comments: review.comments,
        };
      },
    },
  );

  assert.equal(submittedReview?.snapshot.id, fixture.snapshot.id);
  assert.deepEqual(
    submittedReview?.unitProgress.map((progress) => progress.disposition),
    ["reviewed", "reviewed"],
  );
  assert.equal(submittedSignal?.aborted, false);
  assert.deepEqual(customOptions, {
    overlay: true,
    overlayOptions: {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
      margin: 0,
    },
  });
  assert.equal(result.status, "submitted");
});

test("keeps repository drift in the UI with drafts preserved", async () => {
  const failure = await openWithSubmissionFailure(
    new ReviewSnapshotDriftError("repository changed"),
  );

  assert.match(failure.output, /Snapshot changed; submission is blocked/);
  assert.match(failure.output, /Repository drift blocks submission/);
  assert.match(failure.output, /repository changed/);
  assert.match(failure.output, /Draft/);
  assert.match(
    failure.outputAfterModeChange,
    /Repository drift blocks submission/,
  );
  assert.equal(failure.result.status, "paused");
});

test("keeps domain drift rejections in the UI with drafts preserved", async () => {
  const failure = await openWithSubmissionFailure(
    new InProgressReviewError(
      "repository-drifted",
      "Repository state no longer matches review snapshot snapshot-ui.",
    ),
  );

  assert.match(failure.output, /Repository drift blocks submission/);
  assert.match(failure.output, /no longer matches review snapshot/);
  assert.match(failure.output, /Draft/);
  assert.equal(failure.result.status, "paused");
});

test("keeps generic verification failures distinct from drift", async () => {
  const failure = await openWithSubmissionFailure(
    new Error("git executable unavailable"),
  );

  assert.match(failure.output, /Snapshot check failed; submission is blocked/);
  assert.match(failure.output, /Snapshot verification failed/);
  assert.match(failure.output, /git executable unavailable/);
  assert.doesNotMatch(failure.output, /Repository drift blocks submission/);
  assert.match(failure.outputAfterModeChange, /Snapshot verification failed/);
  assert.equal(failure.result.status, "paused");
});

test("fails clearly before opening custom UI outside TUI mode", async () => {
  const fixture = makeUiFixture();
  const ui = {} as ExtensionContext["ui"];

  await assert.rejects(
    openGuidedReview(
      { mode: "print", ui },
      {
        review: makeReview(fixture),
        onReviewChange: () => {},
        onSubmit: unusedSubmit,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof GuidedReviewUiUnavailableError);
      assert.match(error.message, /current mode is print/);
      return true;
    },
  );
});
