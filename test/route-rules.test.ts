import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  loadDiffWalkRules,
  MAX_DIFFWALK_RULES_BYTES,
} from "../src/route-rules.ts";

async function createProject(t: TestContext): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "pi-diffwalk-rules-test-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

function rulesPath(project: string): string {
  return join(project, CONFIG_DIR_NAME, "diffwalk", "rules.md");
}

async function writeRules(
  project: string,
  content: string | Buffer,
): Promise<void> {
  const path = rulesPath(project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("loads and trims trusted project review rules", async (t) => {
  const project = await createProject(t);
  await writeRules(project, "\n- Review public contracts first.\n\n");

  assert.deepEqual(await loadDiffWalkRules(project, true), {
    status: "loaded",
    rules: { content: "- Review public contracts first." },
  });
});

test("distinguishes absent rules from existing rules ignored by trust", async (t) => {
  const project = await createProject(t);

  assert.deepEqual(await loadDiffWalkRules(project, false), {
    status: "absent",
  });

  await writeRules(project, "- Review public contracts first.");
  assert.deepEqual(await loadDiffWalkRules(project, false), {
    status: "ignored-untrusted",
  });
});

test("treats blank project rules as absent", async (t) => {
  const project = await createProject(t);
  await writeRules(project, " \n\t\n");

  assert.deepEqual(await loadDiffWalkRules(project, true), {
    status: "absent",
  });
});

test("reports oversized and invalid UTF-8 rules as unavailable", async (t) => {
  const project = await createProject(t);
  await writeRules(project, Buffer.alloc(MAX_DIFFWALK_RULES_BYTES + 1, "x"));

  const oversized = await loadDiffWalkRules(project, true);
  assert.equal(oversized.status, "unavailable");
  if (oversized.status === "unavailable") {
    assert.match(
      oversized.reason,
      new RegExp(`maximum is ${MAX_DIFFWALK_RULES_BYTES} bytes`),
    );
  }

  await writeRules(project, Buffer.from([0xc3, 0x28]));
  const invalid = await loadDiffWalkRules(project, true);
  assert.equal(invalid.status, "unavailable");
  if (invalid.status === "unavailable") {
    assert.match(invalid.reason, /not valid UTF-8/);
  }
});

test("reports a non-file rules path as unavailable", async (t) => {
  const project = await createProject(t);
  await mkdir(rulesPath(project), { recursive: true });

  const result = await loadDiffWalkRules(project, true);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") {
    assert.match(result.reason, /must be a regular file/);
  }
});
