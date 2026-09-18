import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REFERENCE_TEXT_MAX_LINES,
  readFoldConfiguration,
  readReferenceText,
} from "../../src/extension/fold.ts";
import type { ReviewUnitFeatures } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import { commandContext, createHarness, toolContext } from "./harness.ts";

async function agentDirWith(
  settings: string | undefined,
  auth?: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-diffwalk-fold-"));
  if (settings !== undefined) {
    await writeFile(join(dir, "settings.json"), settings);
  }
  if (auth !== undefined) {
    await writeFile(join(dir, "auth.json"), auth);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("fold configuration is disabled unless settings.json opts in", async (t) => {
  const absent = await agentDirWith(undefined);
  t.after(absent.cleanup);
  assert.deepEqual(await readFoldConfiguration(absent.dir, {}), {
    status: "disabled",
  });

  const unrelated = await agentDirWith('{"diffwalk":{}}');
  t.after(unrelated.cleanup);
  assert.deepEqual(await readFoldConfiguration(unrelated.dir, {}), {
    status: "disabled",
  });

  const broken = await agentDirWith("{not json");
  t.after(broken.cleanup);
  assert.deepEqual(await readFoldConfiguration(broken.dir, {}), {
    status: "disabled",
  });
});

test("fold configuration reports an unknown value or a missing key", async (t) => {
  const other = await agentDirWith('{"diffwalk":{"fold":"openai"}}');
  t.after(other.cleanup);
  const unknown = await readFoldConfiguration(other.dir, {});
  assert.equal(unknown.status, "misconfigured");
  if (unknown.status === "misconfigured") {
    assert.match(unknown.reason, /only supported value is "typesafe"/);
  }

  const enabled = await agentDirWith('{"diffwalk":{"fold":"typesafe"}}');
  t.after(enabled.cleanup);
  const noKey = await readFoldConfiguration(enabled.dir, {});
  assert.equal(noKey.status, "misconfigured");
  if (noKey.status === "misconfigured") {
    assert.match(
      noKey.reason,
      /auth\.json has no "typesafe" api_key credential and TYPESAFE_API_KEY is not set/,
    );
  }

  assert.deepEqual(
    await readFoldConfiguration(enabled.dir, {
      TYPESAFE_API_KEY: "sk",
      TYPESAFE_BASE_URL: "https://proxy.test",
    }),
    { status: "enabled", apiKey: "sk", baseURL: "https://proxy.test" },
  );
});

test("the key comes from pi's auth.json first and the environment second", async (t) => {
  const stored = await agentDirWith(
    '{"diffwalk":{"fold":"typesafe"}}',
    '{"typesafe":{"type":"api_key","key":"sk-stored"},"openai":{"type":"api_key","key":"sk-other"}}',
  );
  t.after(stored.cleanup);
  assert.deepEqual(await readFoldConfiguration(stored.dir, {}), {
    status: "enabled",
    apiKey: "sk-stored",
  });
  assert.deepEqual(
    await readFoldConfiguration(stored.dir, { TYPESAFE_API_KEY: "sk-env" }),
    { status: "enabled", apiKey: "sk-stored" },
  );

  const wrongType = await agentDirWith(
    '{"diffwalk":{"fold":"typesafe"}}',
    '{"typesafe":{"type":"oauth","access":"a","refresh":"r","expires":1}}',
  );
  t.after(wrongType.cleanup);
  assert.equal(
    (await readFoldConfiguration(wrongType.dir, { TYPESAFE_API_KEY: "sk-env" }))
      .status,
    "enabled",
  );
  assert.equal(
    (await readFoldConfiguration(wrongType.dir, {})).status,
    "misconfigured",
  );

  const blankKey = await agentDirWith(
    '{"diffwalk":{"fold":"typesafe"}}',
    '{"typesafe":{"type":"api_key","key":"  "}}',
  );
  t.after(blankKey.cleanup);
  assert.equal(
    (await readFoldConfiguration(blankKey.dir, {})).status,
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

test("with a judge, every unit is folded or walked on its features", async () => {
  const judged: string[] = [];
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    foldConfiguration: { status: "enabled", apiKey: "sk" },
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
  assert.equal(walked.details?.acceptedUnit.fold, undefined);
  assert.deepEqual(walked.details?.acceptedUnit.walked?.blockers, [
    "changes runtime behavior (90%)",
    "adds control flow (80%)",
    "touches authorization",
    "is a behavior change",
  ]);
  assert.match(
    (walked.content[0] as { text: string }).text,
    /^Accepted review unit 1 \(walked: changes runtime behavior \(90%\); adds control flow \(80%\); touches authorization; is a behavior change\)\./,
  );

  const folded = await harness.unitTool.execute(
    "u2",
    unitFor("test/file.test.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(folded.details?.acceptedUnit.fold?.source, "typesafe");
  assert.deepEqual(folded.details?.acceptedUnit.fold?.reasons, [
    "No behavior change (95%), no new control flow (95%).",
    "Test change touching no boundary.",
  ]);
  assert.equal(judged.length, 2);
  assert.match(
    judged[0] ?? "",
    /^--- src\/file\.ts\n@@\n head\n\+changed\n tail$/,
  );

  harness.behavior.submitOnOpen = true;
  await harness.tool.execute("open", {}, undefined, undefined, toolContext());
  const route = harness.openedRoutes.at(-1);
  assert.deepEqual(
    route?.units.map((unit) => unit.fold?.source),
    [undefined, "typesafe"],
    "The fold decisions reach the walkthrough.",
  );
  assert.equal(route?.units[0]?.walked?.source, "typesafe");
  assert.match(
    (folded.content[0] as { text: string }).text,
    /^Accepted review unit 2 \(folded: No behavior change/,
  );
});

test("an agent routine claim adds a reference check but does not fold by itself", async () => {
  const inputs: { unitText: string; referenceText?: string }[] = [];
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    foldConfiguration: { status: "enabled", apiKey: "sk" },
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
  assert.equal(result.details?.acceptedUnit.fold, undefined);
});

test("without a judge the routine claim folds; a judge failure degrades once", async () => {
  const plain = createHarness({ snapshot: twoFileSnapshot() });
  await plain.command("", commandContext());
  const claimed = await plain.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(claimed.details?.acceptedUnit.fold, {
    source: "agent",
    reasons: ["Same."],
  });

  let calls = 0;
  const failing = createHarness({
    snapshot: twoFileSnapshot(),
    foldConfiguration: { status: "enabled", apiKey: "sk" },
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
  assert.equal(first.details?.acceptedUnit.fold, undefined);
  assert.equal(
    second.details?.acceptedUnit.fold,
    undefined,
    "After degrading, the agent claim does not fold either.",
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    notifications.filter((line) => line.includes("Folding is unavailable")),
    [
      "Folding is unavailable for this review: TypeSafe responded with HTTP 503. Every remaining unit will be walked.",
    ],
  );
});

test("a misconfigured fold setting warns and walks everything", async () => {
  const harness = createHarness({
    snapshot: twoFileSnapshot(),
    foldConfiguration: {
      status: "misconfigured",
      reason:
        "settings.json enables diffwalk.fold but TYPESAFE_API_KEY is not set.",
    },
  });
  const notifications: string[] = [];
  await harness.command("", commandContext("tui", notifications));
  assert.match(
    notifications.join("\n"),
    /TYPESAFE_API_KEY is not set\. Folding is off for this review\./,
  );
  const result = await harness.unitTool.execute(
    "u1",
    unitFor("test/file.test.ts", { reference: "src/x.ts", reason: "Same." }),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(result.details?.acceptedUnit.fold, {
    source: "agent",
    reasons: ["Same."],
  });
});
