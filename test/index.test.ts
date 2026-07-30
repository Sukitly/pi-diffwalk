import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

interface Harness {
  readonly command: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly tool: GuidedToolDefinition;
  readonly sentMessages: readonly string[];
}

function createHarness(): Harness {
  const snapshot = makeSnapshot("snapshot-index", [
    { id: "h1", fingerprint: "fp1" },
  ]);
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let tool: GuidedToolDefinition | undefined;
  const sentMessages: string[] = [];
  const pi = {
    registerCommand(
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      assert.equal(name, "review");
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
    async assertReviewSnapshotUnchanged() {},
    async openGuidedReview(_ctx, input) {
      return { status: "cancelled", snapshotId: input.snapshot.id };
    },
  };

  registerDiffWalk(pi, dependencies);
  assert.ok(command);
  assert.ok(tool);
  return { command, tool, sentMessages };
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

test("requires /review and binds the tool route to the pending snapshot", async () => {
  const harness = createHarness();
  const before = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(before.details, {
    status: "error",
    code: "no-pending-review",
  });

  await harness.command(" origin/main ", commandContext());
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /Prepare a semantic route/);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);

  const mismatch = await harness.tool.execute(
    "call-2",
    validRoute("other-snapshot"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(mismatch.details, {
    status: "error",
    code: "snapshot-mismatch",
    expectedSnapshotId: "snapshot-index",
  });

  const invalid = await harness.tool.execute(
    "call-3",
    { ...validRoute(), units: [] },
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(
    (invalid.details as { readonly code?: string }).code,
    "invalid-route",
  );

  const completed = await harness.tool.execute(
    "call-4",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "cancelled",
    snapshotId: "snapshot-index",
  });

  const consumed = await harness.tool.execute(
    "call-5",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(consumed.details, {
    status: "error",
    code: "no-pending-review",
  });
});

test("fails /review clearly outside interactive TUI mode", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.command("", commandContext("print")),
    /requires interactive TUI mode; current mode is print/,
  );
  assert.deepEqual(harness.sentMessages, []);
});

test("formats structured cancellation and submission instructions", () => {
  const cancelled: GuidedReviewResult = {
    status: "cancelled",
    snapshotId: "snapshot-1" as SnapshotId,
  };
  assert.deepEqual(JSON.parse(formatGuidedReviewResult(cancelled)), {
    status: "cancelled",
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
