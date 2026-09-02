import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSnapshotDriftError } from "../../src/git/errors.ts";
import { makeSnapshot } from "../support/domain-fixtures.ts";
import { commandContext, createHarness } from "./harness.ts";

test("project rules replace global rules and the selection is captured once", async () => {
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: {
        scope: "global",
        content: "Review security boundaries before callers.",
      },
    },
    projectRulesResult: {
      status: "loaded",
      rules: {
        scope: "project",
        content: "Keep behavioral tests with their implementation.",
      },
    },
  });

  await harness.command(
    "",
    commandContext("tui", [], true, "/repo/packages/service"),
  );
  const firstPrompt = harness.sentMessages[0] ?? "";
  assert.match(
    firstPrompt,
    /Keep behavioral tests with their implementation\./,
  );
  assert.doesNotMatch(
    firstPrompt,
    /Review security boundaries before callers\./,
  );

  harness.behavior.globalRulesResult = {
    status: "loaded",
    rules: { scope: "global", content: "Changed global rules." },
  };
  harness.behavior.projectRulesResult = {
    status: "loaded",
    rules: { scope: "project", content: "Changed project rules." },
  };
  await harness.command("", commandContext());
  assert.equal(harness.sentMessages[1], firstPrompt);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
  ]);
});

test("falls back to global rules when project rules are absent", async () => {
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
  });

  await harness.command("", commandContext());

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("falls back to global rules when project trust suppresses project rules", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesResult: { status: "ignored-untrusted" },
  });

  await harness.command("", commandContext("tui", notifications, false));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.match(notifications[0] ?? "", /project is not trusted/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: false },
    { scope: "global" },
  ]);
});

test("falls back to global rules when a changed project rules file is ignored", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Skip this file." },
    },
    snapshot: makeSnapshot("snapshot-index", [
      {
        path: ".pi/diffwalk/rules.md",
        lines: ["+- Skip this file."],
      },
    ]),
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.doesNotMatch(harness.sentMessages[0] ?? "", /Skip this file/);
  assert.match(notifications[0] ?? "", /cannot shape the review of their own/);
  assert.deepEqual(harness.ruleLoadCalls, [{ scope: "global" }]);
});

test("does not inspect global rules when project rules are selected", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "unavailable",
      reason: "Global DiffWalk rules are too large.",
    },
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Review project contracts first." },
    },
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review project contracts first\./,
  );
  assert.deepEqual(notifications, []);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
  ]);
});

test("falls back to global rules when project rules are unavailable", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review global contracts first." },
    },
    projectRulesResult: {
      status: "unavailable",
      reason: "Project DiffWalk rules are not valid UTF-8.",
    },
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review global contracts first\./,
  );
  assert.match(notifications[0] ?? "", /Continuing without those rules/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("falls back to global rules when the project rules loader rejects", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    globalRulesResult: {
      status: "loaded",
      rules: { scope: "global", content: "Review public contracts first." },
    },
    projectRulesError: new Error("Injected project loader failure."),
  });

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    harness.sentMessages[0] ?? "",
    /Review public contracts first\./,
  );
  assert.match(notifications[0] ?? "", /Injected project loader failure/);
  assert.match(notifications[0] ?? "", /Continuing without them/);
  assert.deepEqual(harness.ruleLoadCalls, [
    { scope: "project", repositoryRoot: "/repo", projectTrusted: true },
    { scope: "global" },
  ]);
});

test("rejects drift detected after project rules are captured", async () => {
  const harness = createHarness({
    drift: true,
    projectRulesResult: {
      status: "loaded",
      rules: { scope: "project", content: "Review public contracts first." },
    },
  });

  await assert.rejects(
    harness.command("", commandContext()),
    ReviewSnapshotDriftError,
  );
  assert.equal(harness.sentMessages.length, 0);
});
