import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ReviewSnapshotDriftError } from "../src/git-diff.ts";
import { markReviewUnitReviewed } from "../src/in-progress-review.ts";
import {
  createPiGitRunner,
  type DiffWalkDependencies,
  formatGuidedReviewResult,
  parseReviewTarget,
  registerDiffWalk,
} from "../src/index.ts";
import type {
  GuidedReviewResult,
  ReviewRouteCandidate,
  ReviewRouteCandidateSchema,
  SnapshotId,
} from "../src/types.ts";
import { hunkId, makeSnapshot } from "./domain-fixtures.ts";

type GuidedToolDefinition = ToolDefinition<
  typeof ReviewRouteCandidateSchema,
  unknown
>;

interface HarnessBehavior {
  drift: boolean;
  submitOnOpen: boolean;
  submissionDrift: boolean;
}

interface Harness {
  readonly command: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly tool: GuidedToolDefinition;
  readonly sentMessages: readonly string[];
  readonly openedSnapshots: readonly string[];
  readonly behavior: HarnessBehavior;
}

function createHarness(
  initialBehavior: Partial<HarnessBehavior> = {},
): Harness {
  const snapshot = makeSnapshot("snapshot-index", [
    { id: "h1", fingerprint: "fp1" },
  ]);
  const behavior: HarnessBehavior = {
    drift: false,
    submitOnOpen: false,
    submissionDrift: false,
    ...initialBehavior,
  };
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let tool: GuidedToolDefinition | undefined;
  const sentMessages: string[] = [];
  const openedSnapshots: string[] = [];
  const pi = {
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      assert.equal(name, "diffwalk");
      command = options.handler;
    },
    registerTool(definition: GuidedToolDefinition) {
      tool = definition;
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  const dependencies: DiffWalkDependencies = {
    async captureReviewSnapshot(_git, _cwd, targetRef) {
      return {
        ...snapshot,
        comparison: { ...snapshot.comparison, targetRef },
      };
    },
    async captureRepositoryState() {
      const state = snapshot.repositoryState;
      return behavior.submissionDrift
        ? {
            ...state,
            unstagedFingerprint: "drifted" as typeof state.unstagedFingerprint,
          }
        : state;
    },
    async assertReviewSnapshotUnchanged() {
      if (behavior.drift) {
        throw new ReviewSnapshotDriftError("Repository changed.");
      }
    },
    async openGuidedReview(_ctx, input) {
      openedSnapshots.push(input.review.snapshot.id);
      if (!behavior.submitOnOpen) {
        return { status: "paused", snapshotId: input.review.snapshot.id };
      }
      let review = input.review;
      for (const progress of review.unitProgress) {
        review = markReviewUnitReviewed(review, progress.reviewUnitId, {
          expectedVersion: review.version,
          timestamp: new Date().toISOString(),
        });
      }
      input.onReviewChange(review);
      return input.onSubmit(review, new AbortController().signal);
    },
  };

  registerDiffWalk(pi, dependencies);
  assert.ok(command);
  assert.ok(tool);
  return { command, tool, sentMessages, openedSnapshots, behavior };
}

function commandContext(
  mode: ExtensionCommandContext["mode"] = "tui",
  notifications: string[] = [],
): ExtensionCommandContext {
  return {
    mode,
    cwd: "/repo",
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
}

function toolContext(): ExtensionContext {
  return { mode: "tui" } as ExtensionContext;
}

function validRoute(snapshotId = "snapshot-index"): ReviewRouteCandidate {
  return {
    snapshotId,
    units: [
      {
        title: "Entry point",
        whyHere: "Behavior starts here.",
        context: "entry -> implementation",
        changeSummary: "Updates behavior.",
        reviewFocus: ["Is the behavior correct?"],
        hunkIds: [hunkId("h1")],
      },
    ],
    skippedHunks: [],
  };
}

test("parses the default and explicit review targets", () => {
  assert.equal(parseReviewTarget(""), "HEAD");
  assert.equal(parseReviewTarget("  \n"), "HEAD");
  assert.equal(parseReviewTarget(" origin/main "), "origin/main");
});

test("adapts pi.exec to argument-array Git execution", async () => {
  const calls: unknown[] = [];
  const signal = new AbortController().signal;
  const runner = createPiGitRunner(
    {
      async exec(command, args, options) {
        calls.push({ command, args, options });
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
    },
    signal,
  );

  assert.deepEqual(await runner.run(["status", "--short"], "/repo"), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["status", "--short"],
      options: { cwd: "/repo", signal },
    },
  ]);
});

test("requires /diffwalk and binds the tool route to the pending snapshot", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.tool.execute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending.*run \/diffwalk first/,
  );

  await harness.command(" origin/main ", commandContext());
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /Prepare a semantic route/);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);

  await assert.rejects(
    harness.tool.execute(
      "call-2",
      validRoute("other-snapshot"),
      undefined,
      undefined,
      toolContext(),
    ),
    /does not match pending snapshot snapshot-index/,
  );

  await assert.rejects(
    harness.tool.execute(
      "call-3",
      { ...validRoute(), units: [] },
      undefined,
      undefined,
      toolContext(),
    ),
    /Invalid review route:[\s\S]*does not cover required hunk h1[\s\S]*must contain at least one non-empty review unit/,
  );

  const completed = await harness.tool.execute(
    "call-4",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "paused",
    snapshotId: "snapshot-index",
  });

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
  assert.equal(harness.sentMessages.length, 1);

  await assert.rejects(
    harness.tool.execute(
      "call-5",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /already has a validated route.*resume it/,
  );
});

test("rejects a different explicit base while a routed review is pending", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  await assert.rejects(
    harness.command("origin/main", commandContext()),
    /review against HEAD is pending with 0 draft comments[\s\S]*Run \/diffwalk without arguments to resume it/,
  );

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
});

test("discards a drifted paused review and starts a new one", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.drift = true;
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0] ?? "",
    /repository changed while the review[\s\S]*Discarded the stale review and 0 draft comments/,
  );
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /Prepare a semantic route/);
  assert.deepEqual(harness.openedSnapshots, ["snapshot-index"]);
});

test("replaces an unrouted pending review when the target changes or drifts", async () => {
  const harness = createHarness();
  const notifications: string[] = [];
  await harness.command("origin/main", commandContext("tui", notifications));
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);

  await harness.command("origin/release", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.match(
    notifications[0] ?? "",
    /Replacing the pending review against origin\/main/,
  );
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/release"/);

  await harness.command("origin/release", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.equal(harness.sentMessages.length, 3);
  assert.match(harness.sentMessages[2] ?? "", /"targetRef": "origin\/release"/);

  harness.behavior.drift = true;
  await harness.command("", commandContext("tui", notifications));
  assert.equal(notifications.length, 2);
  assert.match(notifications[1] ?? "", /Capturing a new snapshot/);
  assert.match(harness.sentMessages[3] ?? "", /"targetRef": "origin\/release"/);
});

test("rejects repository drift before opening the walkthrough", async () => {
  const harness = createHarness({ drift: true });
  await harness.command("", commandContext());

  await assert.rejects(
    harness.tool.execute(
      "call-drift",
      validRoute(),
      new AbortController().signal,
      undefined,
      toolContext(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSnapshotDriftError);
      assert.match(
        error.message,
        /Run \/diffwalk again before opening DiffWalk/,
      );
      return true;
    },
  );
  assert.deepEqual(harness.openedSnapshots, []);

  await assert.rejects(
    harness.tool.execute(
      "call-stale",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending/,
  );
});

test("submits through the domain pipeline against the captured repository state", async () => {
  const harness = createHarness({ submissionDrift: true });
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());

  await assert.rejects(
    harness.tool.execute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /no longer matches review snapshot/,
  );
});

test("keeps completed rounds in memory as the next delta baseline", async () => {
  const harness = createHarness();
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  assert.match(harness.sentMessages[0] ?? "", /"needsReviewHunkCount": 1/);

  const submitted = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const details = submitted.details as { readonly status: string };
  assert.equal(details.status, "submitted");

  await harness.command("", commandContext());
  const kickoff = harness.sentMessages.at(-1) ?? "";
  assert.equal(harness.sentMessages.length, 2);
  assert.match(kickoff, /"needsReviewHunkCount": 0/);
  assert.match(kickoff, /"carriedForwardHunkCount": 1/);
  assert.match(kickoff, /"baselineRoundId": "review-round:/);
});

test("fails /diffwalk clearly outside interactive TUI mode", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.command("", commandContext("print")),
    /requires interactive TUI mode; current mode is print/,
  );
  assert.deepEqual(harness.sentMessages, []);
});

test("formats structured pause, discard, and submission instructions", () => {
  const paused: GuidedReviewResult = {
    status: "paused",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  const formattedPause = JSON.parse(formatGuidedReviewResult(paused)) as {
    readonly status: string;
    readonly instruction: string;
  };
  assert.equal(formattedPause.status, "paused");
  assert.match(
    formattedPause.instruction,
    /Do not modify repository files or Git state until the user resumes/,
  );

  const discarded: GuidedReviewResult = {
    status: "discarded",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  const formattedDiscard = JSON.parse(formatGuidedReviewResult(discarded)) as {
    readonly instruction: string;
  };
  assert.match(formattedDiscard.instruction, /discarded the review/);

  const submitted: GuidedReviewResult = {
    status: "submitted",
    snapshotId: "snapshot-1" as SnapshotId,
    submissionMode: "discuss-first",
    comments: [],
  };
  const formatted = JSON.parse(formatGuidedReviewResult(submitted)) as {
    readonly instruction: string;
  };
  assert.match(formatted.instruction, /without modifying files/);
});
