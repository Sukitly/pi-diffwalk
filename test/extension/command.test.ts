import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDiffWalkCommand,
  parseReviewTarget,
} from "../../src/extension/command.ts";
import {
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
} from "../../src/extension/tui-messages.ts";
import type { NoticeId } from "../../src/review/types.ts";
import { makeSnapshot } from "../support/domain-fixtures.ts";
import {
  binaryChange,
  commandContext,
  createHarness,
  toolContext,
  validRoute,
} from "./harness.ts";

test("parses the default and explicit review targets", () => {
  assert.equal(parseReviewTarget(""), "HEAD");
  assert.equal(parseReviewTarget("  \n"), "HEAD");
  assert.equal(parseReviewTarget(" origin/main "), "origin/main");
});

test("separates the discard option from a base revision", () => {
  assert.deepEqual(parseDiffWalkCommand("  "), { type: "review" });
  assert.deepEqual(parseDiffWalkCommand(" origin/main "), {
    type: "review",
    targetRef: "origin/main",
  });
  assert.deepEqual(parseDiffWalkCommand(" --discard "), { type: "discard" });
  assert.deepEqual(parseDiffWalkCommand(" --threads "), { type: "threads" });
  assert.throws(
    () => parseDiffWalkCommand("--drop"),
    /Unknown \/diffwalk option --drop/,
  );
});

test("rejects a different explicit base once the human worked in the review", async () => {
  const harness = createHarness({ markProgressOnOpen: true });
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
    /review against HEAD is pending with 0 draft comments and 1 reviewed unit[\s\S]*\/diffwalk --discard to drop it/,
  );

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
});

test("replaces an untouched routed review when the base changes", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const notifications: string[] = [];
  await harness.command("origin/main", commandContext("tui", notifications));

  assert.match(
    notifications[0] ?? "",
    /Replacing the untouched review against HEAD with a review against origin\/main/,
  );
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/main"/);
});

test("discards a pending review without opening the walkthrough", async () => {
  const harness = createHarness();
  const notifications: string[] = [];
  await harness.command("--discard", commandContext("tui", notifications));
  assert.deepEqual(notifications, ["No DiffWalk review is pending."]);

  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  await harness.command("--discard", commandContext("tui", notifications));
  assert.match(
    notifications[1] ?? "",
    /Discarded the pending DiffWalk review against HEAD and 0 draft comments/,
  );

  await harness.command("origin/main", commandContext("tui", notifications));
  assert.equal(notifications.length, 2);
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1] ?? "", /"targetRef": "origin\/main"/);
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

test("reports a comparison with nothing to review instead of starting one", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-clean", []),
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(harness.sentMessages, []);
  assert.deepEqual(harness.openedSnapshots, []);
  assert.match(
    notifications[0] ?? "",
    /No line needs review against HEAD\. The worktree matches the comparison\./,
  );

  harness.behavior.snapshot = makeSnapshot("snapshot-index", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
  ]);
  await harness.command("origin/main", commandContext("tui", notifications));
  assert.equal(notifications.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);
});

test("names carried-forward, unreviewable, and noticed changes when nothing needs review", async () => {
  const harness = createHarness();
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.snapshot = makeSnapshot(
    "snapshot-carried",
    [{ path: "src/file.ts", lines: [" head", "+changed", " tail"] }],
    {
      changes: [binaryChange()],
      notices: [
        {
          id: "notice-1" as NoticeId,
          type: "cancelled-layer-change",
          message: "A submodule change was not reviewed.",
        },
      ],
    },
  );
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.equal(harness.sentMessages.length, 1);
  assert.match(
    notifications[0] ?? "",
    /No line needs review against HEAD\. 1 changed line already reviewed in round 1\. assets\/logo\.png cannot be reviewed line by line: Binary file\. A submodule change was not reviewed\./,
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

test("completes a resumed review with no comments without messaging the agent", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.submitOnOpen = true;
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(
    harness.sentMessageMeta.map((meta) => meta.customType),
    [DIFFWALK_KICKOFF_MESSAGE_TYPE],
  );
  assert.equal(harness.appendedEntries.length, 1);
  assert.deepEqual(notifications, [
    "Review complete. No comments submitted. No agent follow-up needed.",
  ]);
});

test("reports resumed pauses and discards with the tool outcome wording", async () => {
  const pausedHarness = createHarness();
  await pausedHarness.command("", commandContext());
  await pausedHarness.tool.execute(
    "call-paused",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const pausedNotifications: string[] = [];
  await pausedHarness.command("", commandContext("tui", pausedNotifications));
  assert.deepEqual(pausedNotifications, [
    "Review paused. Progress and draft comments remain resumable while the snapshot matches. Repository changes are allowed; the next /diffwalk discards a stale review and starts over.",
  ]);

  const discardedHarness = createHarness();
  await discardedHarness.command("", commandContext());
  await discardedHarness.tool.execute(
    "call-discarded",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  discardedHarness.behavior.discardOnOpen = true;
  const discardedNotifications: string[] = [];
  await discardedHarness.command(
    "",
    commandContext("tui", discardedNotifications),
  );
  assert.deepEqual(discardedNotifications, [
    "Review discarded. Progress and draft comments removed.",
  ]);
});

test("sends a resumed submission result when comments need an agent response", async () => {
  const harness = createHarness();
  await harness.command("", commandContext());
  await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.submitOnOpen = true;
  harness.behavior.commentOnSubmit = true;
  await harness.command("", commandContext());

  assert.deepEqual(
    harness.sentMessageMeta.map((meta) => meta.customType),
    [DIFFWALK_KICKOFF_MESSAGE_TYPE, DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE],
  );
  assert.deepEqual(harness.sentMessageMeta[1], {
    customType: DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });
  assert.match(harness.sentMessages[1] ?? "", /"status":"submitted"/);
  assert.match(harness.sentMessages[1] ?? "", /Check this behavior/);
});
