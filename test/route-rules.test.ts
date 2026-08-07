import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  DIFFWALK_RULES_SOURCE,
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

async function writeRules(project: string, content: string | Buffer) {
  const path = rulesPath(project);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("loads and trims trusted project review rules", async (t) => {
  const project = await createProject(t);
  await writeRules(project, "\n- Review public contracts first.\n\n");

  assert.deepEqual(await loadDiffWalkRules(project, true), {
    source: DIFFWALK_RULES_SOURCE,
    content: "- Review public contracts first.",
  });
});

test("does not read project rules when the project is untrusted", async (t) => {
  const project = await createProject(t);
  await writeRules(project, Buffer.alloc(MAX_DIFFWALK_RULES_BYTES + 1, "x"));

  assert.equal(await loadDiffWalkRules(project, false), undefined);
});

test("ignores missing and blank project rule files", async (t) => {
  const project = await createProject(t);

  assert.equal(await loadDiffWalkRules(project, true), undefined);
  await writeRules(project, " \n\t\n");
  assert.equal(await loadDiffWalkRules(project, true), undefined);
});

test("rejects project rules that would consume excessive context", async (t) => {
  const project = await createProject(t);
  await writeRules(project, Buffer.alloc(MAX_DIFFWALK_RULES_BYTES + 1, "x"));

  await assert.rejects(
    loadDiffWalkRules(project, true),
    new RegExp(`maximum is ${MAX_DIFFWALK_RULES_BYTES} bytes`),
  );
});
