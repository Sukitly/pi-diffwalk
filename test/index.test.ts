import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ReviewSnapshotDriftError } from "../src/git-diff.ts";
import {
  createPiGitRunner,
  type DiffWalkDependencies,
  formatGuidedReviewResult,
  parseReviewTarget,
  registerDiffWalk,
  resolveSourceBranch,
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

interface Harness {
  readonly command: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly tool: GuidedToolDefinition;
  readonly sentMessages: readonly string[];
  readonly openedSnapshots: readonly string[];
}

function createHarness(options: { readonly drift?: boolean } = {}): Harness {
  const snapshot = makeSnapshot("snapshot-index", [
    { id: "h1", fingerprint: "fp1" },
  ]);
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
    async assertReviewSnapshotUnchanged() {
      if (options.drift) {
        throw new ReviewSnapshotDriftError("Repository changed.");
      }
    },
    async openGuidedReview(_ctx, input) {
      openedSnapshots.push(input.snapshot.id);
      return { status: "paused", snapshotId: input.snapshot.id };
    },
    async resolveSourceBranch() {
      return "feature";
    },
  };

  registerDiffWalk(pi, dependencies);
  assert.ok(command);
  assert.ok(tool);
  return { command, tool, sentMessages, openedSnapshots };
}

function commandContext(
  mode: ExtensionCommandContext["mode"] = "tui",
): ExtensionCommandContext {
  return { mode, cwd: "/repo" } as ExtensionCommandContext;
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

test("resolves branch and detached source identities", async () => {
  const snapshot = makeSnapshot("snapshot-branch", []);
  const branch = await resolveSourceBranch(
    {
      async exec() {
        return {
          stdout: "feature/review\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      },
    },
    "/repo",
    snapshot,
  );
  const detached = await resolveSourceBranch(
    {
      async exec() {
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    },
    "/repo",
    snapshot,
  );

  assert.equal(branch, "feature/review");
  assert.equal(detached, `detached:${snapshot.comparison.sourceHeadOid}`);
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

test("fails /diffwalk clearly outside interactive TUI mode", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.command("", commandContext("print")),
    /requires interactive TUI mode; current mode is print/,
  );
  assert.deepEqual(harness.sentMessages, []);
});

test("formats structured pause and submission instructions", () => {
  const paused: GuidedReviewResult = {
    status: "paused",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  assert.deepEqual(JSON.parse(formatGuidedReviewResult(paused)), {
    status: "paused",
    snapshotId: "snapshot-1",
  });

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
