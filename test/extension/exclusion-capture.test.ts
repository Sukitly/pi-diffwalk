import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSnapshotDriftError } from "../../src/git/errors.ts";
import { makeSnapshot } from "../support/domain-fixtures.ts";
import { commandContext, createHarness } from "./harness.ts";

function lockfileSnapshot(id = "snapshot-lock") {
  return makeSnapshot(id, [
    { path: "package-lock.json", lines: [" {", '+  "a": 1', " }"] },
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
  ]);
}

test("a project exclude file replaces the global one and is passed to Git with attributes enabled", async () => {
  const harness = createHarness({
    snapshot: lockfileSnapshot(),
    globalExcludeFile: {
      status: "found",
      scope: "global",
      path: "/home/user/.pi/agent/diffwalk/exclude",
    },
    projectExcludeFile: {
      status: "found",
      scope: "project",
      path: "/repo/.pi/diffwalk/exclude",
    },
    pathExclusionFacts: {
      excludedPaths: new Map([["package-lock.json", "*-lock.json"]]),
      generatedPaths: new Set(),
    },
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(harness.pathExclusionCalls, [
    {
      repositoryRoot: "/repo",
      paths: ["package-lock.json", "src/file.ts"],
      sources: {
        excludeFile: "/repo/.pi/diffwalk/exclude",
        generatedAttribute: true,
      },
    },
  ]);
  assert.deepEqual(notifications, []);
  const prompt = harness.sentMessages[0] ?? "";
  assert.match(prompt, /"excludedLineCount": 1/);
  assert.match(
    prompt,
    /"excluded": \[\s*\{\s*"reason": "excluded-path",\s*"pattern": "\*-lock\.json",\s*"new": \[\s*"2"\s*\]\s*\}\s*\]/,
  );
  assert.match(prompt, /Do not cover lines listed under `excluded`/);
});

test("falls back to the global exclude file when the project file is absent", async () => {
  const harness = createHarness({
    snapshot: lockfileSnapshot(),
    globalExcludeFile: {
      status: "found",
      scope: "global",
      path: "/home/user/.pi/agent/diffwalk/exclude",
    },
  });

  await harness.command("", commandContext());

  assert.equal(
    harness.pathExclusionCalls[0]?.sources.excludeFile,
    "/home/user/.pi/agent/diffwalk/exclude",
  );
});

test("ignores project-owned sources when the project is not trusted", async () => {
  const harness = createHarness({
    snapshot: lockfileSnapshot(),
    globalExcludeFile: {
      status: "found",
      scope: "global",
      path: "/home/user/.pi/agent/diffwalk/exclude",
    },
    projectExcludeFile: {
      status: "found",
      scope: "project",
      path: "/repo/.pi/diffwalk/exclude",
    },
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications, false));

  assert.deepEqual(harness.pathExclusionCalls[0]?.sources, {
    excludeFile: "/home/user/.pi/agent/diffwalk/exclude",
    generatedAttribute: false,
  });
  assert.match(
    notifications.join("\n"),
    /Ignored linguist-generated attributes because the project is not trusted/,
  );
  assert.match(
    notifications.join("\n"),
    /Ignored \.pi\/diffwalk\/exclude because the project is not trusted/,
  );
});

test("ignores a project exclude file or attributes file that is part of the change", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-self", [
      { path: ".pi/diffwalk/exclude", lines: ["+*.lock"] },
      { path: "packages/a/.gitattributes", lines: ["+* linguist-generated"] },
      { path: "a.lock", lines: ["+x"] },
    ]),
    projectExcludeFile: {
      status: "found",
      scope: "project",
      path: "/repo/.pi/diffwalk/exclude",
    },
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(harness.pathExclusionCalls, []);
  assert.match(
    notifications.join("\n"),
    /Ignored \.pi\/diffwalk\/exclude because it is part of snapshot snapshot-self/,
  );
  assert.match(
    notifications.join("\n"),
    /Ignored linguist-generated attributes because a \.gitattributes file is part of snapshot snapshot-self/,
  );
  assert.match(harness.sentMessages[0] ?? "", /"excludedLineCount": 0/);
});

test("routes every line and warns when Git cannot evaluate path exclusions", async () => {
  const harness = createHarness({
    snapshot: lockfileSnapshot(),
    globalExcludeFile: {
      status: "found",
      scope: "global",
      path: "/home/user/.pi/agent/diffwalk/exclude",
    },
    pathExclusionError: new Error("git exploded"),
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.match(
    notifications[0] ?? "",
    /Cannot evaluate path exclusions: git exploded Routing every changed line\./,
  );
  assert.match(harness.sentMessages[0] ?? "", /"excludedLineCount": 0/);
});

test("--no-exclude skips every rule, including whitespace-only detection", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-ws", [
      { path: "src/file.ts", lines: [" head", "-x  ", "+x", " tail"] },
    ]),
    globalExcludeFile: {
      status: "found",
      scope: "global",
      path: "/home/user/.pi/agent/diffwalk/exclude",
    },
  });

  await harness.command("--no-exclude", commandContext());

  assert.deepEqual(harness.pathExclusionCalls, []);
  assert.match(harness.sentMessages[0] ?? "", /"excludedLineCount": 0/);
  assert.match(harness.sentMessages[0] ?? "", /"needsReviewLineCount": 2/);
});

test("whitespace-only lines are excluded without any exclude file", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-ws", [
      {
        path: "src/file.ts",
        lines: [" head", "-x  ", "+x", " mid", "+real", " tail"],
      },
    ]),
  });

  await harness.command("", commandContext());

  assert.deepEqual(harness.pathExclusionCalls[0]?.sources, {
    generatedAttribute: true,
  });
  const prompt = harness.sentMessages[0] ?? "";
  assert.match(prompt, /"excludedLineCount": 2/);
  assert.match(prompt, /"needsReviewLineCount": 1/);
  assert.match(prompt, /"reason": "whitespace-only"/);
});

test("reports excluded lines when nothing is left to review", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-only-ws", [
      { path: "src/file.ts", lines: [" head", "-x  ", "+x", " tail"] },
    ]),
  });
  const notifications: string[] = [];

  await harness.command("", commandContext("tui", notifications));

  assert.deepEqual(harness.sentMessages, []);
  assert.match(
    notifications[0] ?? "",
    /No line needs review against HEAD\. 2 changed lines excluded by mechanical rules; run \/diffwalk --no-exclude to review them\./,
  );
  assert.doesNotMatch(notifications[0] ?? "", /worktree matches/);
});

test("rejects drift detected after a project exclude file is used", async () => {
  const harness = createHarness({
    drift: true,
    snapshot: lockfileSnapshot(),
    projectExcludeFile: {
      status: "found",
      scope: "project",
      path: "/repo/.pi/diffwalk/exclude",
    },
  });

  await assert.rejects(
    harness.command("", commandContext()),
    ReviewSnapshotDriftError,
  );
  assert.equal(harness.pathExclusionCalls.length, 1);
  assert.equal(harness.sentMessages.length, 0);

  harness.behavior.projectExcludeFile = { status: "absent" };
  harness.behavior.globalExcludeFile = {
    status: "found",
    scope: "global",
    path: "/home/user/.pi/agent/diffwalk/exclude",
  };
  await harness.command("", commandContext());
  assert.equal(harness.sentMessages.length, 1);
});
