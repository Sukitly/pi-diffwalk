import assert from "node:assert/strict";
import test from "node:test";
import { createPiGitRunner } from "../../src/extension/git-runner.ts";
import { DIFFWALK_SERIES_ENTRY_TYPE } from "../../src/review/persistence.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import {
  commandContext,
  createHarness,
  toolContext,
  validRoute,
} from "./harness.ts";

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

test("keeps completed rounds in memory as the next delta baseline", async () => {
  const harness = createHarness();
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  assert.match(harness.sentMessages[0] ?? "", /"needsReviewLineCount": 1/);

  const submitted = await harness.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const details = submitted.details as { readonly status: string };
  assert.equal(details.status, "submitted");
  assert.equal(submitted.terminate, true);

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await harness.command("", commandContext());
  const kickoff = harness.sentMessages.at(-1) ?? "";
  assert.equal(harness.sentMessages.length, 2);
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.match(kickoff, /"baselineRoundId": "review-round:/);
});

test("persists submitted rounds and restores the baseline on session start", async () => {
  const first = createHarness();
  first.behavior.submitOnOpen = true;
  await first.command("", commandContext());
  await first.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(first.appendedEntries.length, 1);
  assert.equal(
    first.appendedEntries[0]?.customType,
    DIFFWALK_SERIES_ENTRY_TYPE,
  );

  const second = createHarness();
  await second.restoreSession(first.appendedEntries);
  second.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await second.command("", commandContext());

  const kickoff = second.sentMessages[0] ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.match(kickoff, /"baselineRoundId": "review-round:/);
});

test("the latest persisted entry for a series wins on restore", async () => {
  const first = createHarness();
  first.behavior.submitOnOpen = true;
  await first.command("", commandContext());
  await first.tool.execute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  first.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+appended"] },
  ]);
  await first.command("", commandContext());
  await first.tool.execute(
    "call-2",
    {
      ...validRoute("snapshot-round-2"),
      units: [
        {
          title: "Appended line",
          whyHere: "Only new line this round.",
          context: "tail -> appended",
          changeSummary: "Appends a line.",
          reviewFocus: [{ question: "Is the appended line correct?" }],
          spans: [span("src/file.ts", { new: [4, 4] })],
        },
      ],
    },
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(first.appendedEntries.length, 2);

  const third = createHarness();
  await third.restoreSession(first.appendedEntries);
  third.behavior.snapshot = makeSnapshot("snapshot-round-3", [
    {
      path: "src/file.ts",
      lines: [" head", "+changed", " tail", "+appended", "+third"],
    },
  ]);
  await third.command("", commandContext());

  const kickoff = third.sentMessages[0] ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 2/);
});

test("ignores incompatible or corrupt persisted entries", async () => {
  const harness = createHarness();
  await harness.restoreSession([
    { customType: DIFFWALK_SERIES_ENTRY_TYPE, data: { formatVersion: 99 } },
    { customType: DIFFWALK_SERIES_ENTRY_TYPE, data: "garbage" },
    { customType: "unrelated-extension", data: { anything: true } },
  ]);

  await harness.command("", commandContext());
  const kickoff = harness.sentMessages[0] ?? "";
  assert.match(kickoff, /"baselineRoundId": null/);
  assert.match(kickoff, /"carriedForwardLineCount": 0/);
});
