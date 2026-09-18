import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REFERENCE_TEXT_MAX_LINES,
  readReferenceText,
  readSkipConfiguration,
} from "../../src/extension/skip.ts";
import type { ReviewUnitFeatures } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import { commandContext, createHarness, toolContext } from "./harness.ts";

async function agentDirWith(
  settings: string | undefined,
  auth?: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-diffwalk-skip-"));
  if (settings !== undefined) {
    await writeFile(join(dir, "settings.json"), settings);
  }
  if (auth !== undefined) {
    await writeFile(join(dir, "auth.json"), auth);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("skip configuration is disabled unless settings.json opts in", async (t) => {
  const absent = await agentDirWith(undefined);
  t.after(absent.cleanup);
  assert.deepEqual(await readSkipConfiguration(absent.dir, {}), {
    status: "disabled",
  });

  const unrelated = await agentDirWith('{"diffwalk":{}}');
  t.after(unrelated.cleanup);
  assert.deepEqual(await readSkipConfiguration(unrelated.dir, {}), {
    status: "disabled",
  });

  const broken = await agentDirWith("{not json");
  t.after(broken.cleanup);
  assert.deepEqual(await readSkipConfiguration(broken.dir, {}), {
    status: "disabled",
  });
});

test("skip configuration reports an unknown value or a missing key", async (t) => {
  const other = await agentDirWith('{"diffwalk":{"skip":"openai"}}');
  t.after(other.cleanup);
  const unknown = await readSkipConfiguration(other.dir, {});
  assert.equal(unknown.status, "misconfigured");
  if (unknown.status === "misconfigured") {
    assert.match(unknown.reason, /only supported value is "typesafe"/);
  }

  const enabled = await agentDirWith('{"diffwalk":{"skip":"typesafe"}}');
  t.after(enabled.cleanup);
  const noKey = await readSkipConfiguration(enabled.dir, {});
  assert.equal(noKey.status, "misconfigured");
  if (noKey.status === "misconfigured") {
    assert.match(
      noKey.reason,
      /auth\.json has no "typesafe" api_key credential and TYPESAFE_API_KEY is not set/,
    );
  }

  assert.deepEqual(
    await readSkipConfiguration(enabled.dir, {
      TYPESAFE_API_KEY: "sk",
      TYPESAFE_BASE_URL: "https://proxy.test",
    }),
    { status: "enabled", apiKey: "sk", baseURL: "https://proxy.test" },
  );
});

test("the key comes from pi's auth.json first and the environment second", async (t) => {
  const stored = await agentDirWith(
    '{"diffwalk":{"skip":"typesafe"}}',
    '{"typesafe":{"type":"api_key","key":"sk-stored"},"openai":{"type":"api_key","key":"sk-other"}}',
  );
  t.after(stored.cleanup);
  assert.deepEqual(await readSkipConfiguration(stored.dir, {}), {
    status: "enabled",
    apiKey: "sk-stored",
  });
  assert.deepEqual(
    await readSkipConfiguration(stored.dir, { TYPESAFE_API_KEY: "sk-env" }),
    { status: "enabled", apiKey: "sk-stored" },
  );

  const wrongType = await agentDirWith(
    '{"diffwalk":{"skip":"typesafe"}}',
    '{"typesafe":{"type":"oauth","access":"a","refresh":"r","expires":1}}',
  );
  t.after(wrongType.cleanup);
  assert.equal(
    (await readSkipConfiguration(wrongType.dir, { TYPESAFE_API_KEY: "sk-env" }))
      .status,
    "enabled",
  );
  assert.equal(
    (await readSkipConfiguration(wrongType.dir, {})).status,
    "misconfigured",
  );

  const blankKey = await agentDirWith(
    '{"diffwalk":{"skip":"typesafe"}}',
    '{"typesafe":{"type":"api_key","key":"  "}}',
  );
  t.after(blankKey.cleanup);
  assert.equal(
    (await readSkipConfiguration(blankKey.dir, {})).status,
    "misconfigured",
  );
});

test("reads the referenced lines from the worktree with a bounded window", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "pi-diffwalk-ref-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(join(repository, "src"), { recursive: true });
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(repository, "src", "a.ts"), lines.join("\n"));

  assert.equal(
    await readReferenceText(repository, "src/a.ts:10-12"),
    "line 10\nline 11\nline 12",
  );
  assert.equal(
    (await readReferenceText(repository, "src/a.ts:5"))?.split("\n").length,
    REFERENCE_TEXT_MAX_LINES,
  );
  assert.equal(
    (await readReferenceText(repository, "src/a.ts"))?.split("\n")[0],
    "line 1",
  );
  assert.equal(await readReferenceText(repository, "src/a.ts:500"), undefined);
  assert.equal(
    await readReferenceText(repository, "src/missing.ts"),
    undefined,
  );
  assert.equal(await readReferenceText(repository, ""), undefined);
});

const clear: ReviewUnitFeatures = {
  changesBehavior: 0.05,
  newControlFlow: 0.05,
  touchesBoundary: { choice: "none", confidence: 0.95 },
  kind: { choice: "test", confidence: 0.9 },
};

const risky: ReviewUnitFeatures = {
  changesBehavior: 0.9,
  newControlFlow: 0.8,
  touchesBoundary: { choice: "authorization", confidence: 0.9 },
  kind: { choice: "behavior", confidence: 0.9 },
};

function twoFileSnapshot() {
  return makeSnapshot("snapshot-index", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
    { path: "test/file.test.ts", lines: [" head", "+expect(1)", " tail"] },
  ]);
}

function unitFor(
  path: string,
  routine?: { reference: string; reason: string },
) {
  return {
    title: path,
    whyHere: "Next.",
    context: "ctx",
    changeSummary: "Adds a line.",
    reviewFocus: [],
    spans: [span(path, { new: [2, 2] })],
    ...(routine === undefined ? {} : { routine }),
  };
}

test("with a judge, a unit is walked or removed from the route entirely", async () => {
  const judged: string[] = [];
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    skipConfiguration: { status: "enabled", apiKey: "sk" },
    unitFeatureJudge: async (input) => {
      judged.push(input.unitText);
      return input.unitText.includes("expect(1)") ? clear : risky;
    },
  });
  await harness.command("", commandContext());

  const walked = await harness.unitTool.execute(
    "u1",
    unitFor("src/file.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(walked.details?.skip, undefined);
  assert.match(
    (walked.content[0] as { text: string }).text,
    /^Accepted review unit 1\./,
  );

  const skipped = await harness.unitTool.execute(
    "u2",
    unitFor("test/file.test.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(skipped.details?.skip?.source, "typesafe");
  assert.deepEqual(skipped.details?.skip?.reasons, [
    "Test change, no boundary.",
  ]);
  assert.match(
    (skipped.content[0] as { text: string }).text,
    /^Accepted review unit 2 \(skipped, the reviewer will not see it: Test change, no boundary\.\)/,
  );
  assert.equal(judged.length, 2);
  assert.match(
    judged[0] ?? "",
    /^--- src\/file\.ts\n@@\n head\n\+changed\n tail$/,
  );

  harness.behavior.submitOnOpen = true;
  await harness.tool.execute("open", {}, undefined, undefined, toolContext());
  const route = harness.openedRoutes.at(-1);
  assert.deepEqual(
    route?.units.map((unit) => unit.title),
    ["src/file.ts"],
    "The skipped unit never reaches the walkthrough.",
  );
  assert.deepEqual(
    route?.skippedUnits.map((unit) => unit.title),
    ["test/file.test.ts"],
  );
  assert.equal(route?.skippedUnits[0]?.changedLineCount, 1);
  assert.match(
    route?.skippedSpans.at(-1)?.reason ?? "",
    /^test\/file\.test\.ts: Test change, no boundary\.$/,
  );
});

test("a unit carrying an unresolved comment is walked without asking the judge", async () => {
  let calls = 0;
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    skipConfiguration: { status: "enabled", apiKey: "sk" },
    unitFeatureJudge: async () => {
      calls += 1;
      return risky;
    },
  });
  harness.behavior.commentOnSubmit = true;
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());
  await harness.submitRoute(
    "round-1",
    {
      snapshotId: "snapshot-index",
      units: [unitFor("src/file.ts"), unitFor("test/file.test.ts")],
      skippedSpans: [],
    },
    undefined,
    undefined,
    toolContext(),
  );
  const first = harness.appendedEntries.find(
    (entry) => entry.customType === "diffwalk-thread-batch",
  );
  assert.ok(first, "The first round left an unresolved comment behind.");
  calls = 0;
  harness.behavior.submitOnOpen = false;
  await harness.responseTool.execute(
    "answer",
    { responses: [{ threadId: "C1", body: "Answered." }] },
    undefined,
    undefined,
    toolContext(),
  );

  await harness.command("", commandContext());
  const commented = await harness.unitTool.execute(
    "u1",
    unitFor("src/file.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(calls, 0);
  assert.equal(commented.details?.skip, undefined);
});

test("an agent routine claim adds a reference to the judge's state", async () => {
  const inputs: { unitText: string; referenceText?: string }[] = [];
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    skipConfiguration: { status: "enabled", apiKey: "sk" },
    referenceText: "expect(0)",
    unitFeatureJudge: async (input) => {
      inputs.push(input);
      return { ...clear, mirrorsReference: 0.3 };
    },
  });
  await harness.command("", commandContext());

  const result = await harness.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", {
      reference: "test/other.test.ts:1-3",
      reason: "Same assertion.",
    }),
    undefined,
    undefined,
    toolContext(),
  );

  assert.deepEqual(inputs[0], {
    unitText: "--- test/file.test.ts\n@@\n head\n+expect(1)\n tail",
    referenceText: "expect(0)",
  });
  assert.deepEqual(result.details?.skip?.reasons, [
    "Test change, no boundary.",
    "Mirrors the named reference (30%).",
  ]);
});

test("without a judge the routine claim skips; a judge failure degrades once", async () => {
  const plain = createHarness({ snapshot: twoFileSnapshot() });
  await plain.command("", commandContext());
  const claimed = await plain.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(claimed.details?.skip, {
    source: "agent",
    reasons: ["Same."],
  });
  assert.match(
    (claimed.content[0] as { text: string }).text,
    /skipped, the reviewer will not see it: your routine claim/,
  );

  let calls = 0;
  const failing = createHarness({
    snapshot: twoFileSnapshot(),
    skipConfiguration: { status: "enabled", apiKey: "sk" },
    unitFeatureJudge: async () => {
      calls += 1;
      throw new Error("TypeSafe responded with HTTP 503.");
    },
  });
  const notifications: string[] = [];
  await failing.command("", commandContext("tui", notifications));
  const first = await failing.unitTool.execute(
    "u1",
    unitFor("src/file.ts"),
    undefined,
    undefined,
    toolContext(notifications),
  );
  const second = await failing.unitTool.execute(
    "u2",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(notifications),
  );
  assert.equal(first.details?.skip, undefined);
  assert.equal(
    second.details?.skip,
    undefined,
    "After degrading, the agent claim does not skip either.",
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    notifications.filter((line) =>
      line.includes("Automatic skipping is unavailable"),
    ),
    [
      "Automatic skipping is unavailable for this review: TypeSafe responded with HTTP 503. Every remaining unit will be walked.",
    ],
  );
});

test("a misconfigured skip setting warns and walks everything", async () => {
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    skipConfiguration: {
      status: "misconfigured",
      reason:
        "settings.json enables diffwalk.skip but TYPESAFE_API_KEY is not set.",
    },
  });
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));
  assert.match(
    notifications.join("\n"),
    /TYPESAFE_API_KEY is not set\. Automatic skipping is off for this review\./,
  );
  const result = await harness.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(result.details?.skip, {
    source: "agent",
    reasons: ["Same."],
  });
});

test("--no-skip walks every unit, including routine claims", async () => {
  const harness = createHarness({ snapshot: twoFileSnapshot() });
  await harness.command("--no-skip", commandContext());
  const claimed = await harness.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(claimed.details?.skip, undefined);
});
