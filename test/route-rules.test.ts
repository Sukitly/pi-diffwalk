import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  loadGlobalDiffWalkRules,
  loadProjectDiffWalkRules,
  MAX_DIFFWALK_RULES_BYTES,
} from "../src/route-rules.ts";

async function createRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-diffwalk-rules-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function globalRulesPath(agentDir: string): string {
  return join(agentDir, "diffwalk", "rules.md");
}

function projectRulesPath(repositoryRoot: string): string {
  return join(repositoryRoot, CONFIG_DIR_NAME, "diffwalk", "rules.md");
}

async function writeRules(
  path: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("loads global review rules from the agent directory", async (t) => {
  const agentDir = await createRoot(t);
  await writeRules(
    globalRulesPath(agentDir),
    "\n- Review public contracts first.\n\n",
  );

  assert.deepEqual(await loadGlobalDiffWalkRules(agentDir), {
    status: "loaded",
    rules: {
      scope: "global",
      content: "- Review public contracts first.",
    },
  });
});

test("loads trusted project review rules from the repository root", async (t) => {
  const repositoryRoot = await createRoot(t);
  await writeRules(
    projectRulesPath(repositoryRoot),
    "- Keep tests with their implementation.",
  );

  assert.deepEqual(await loadProjectDiffWalkRules(repositoryRoot, true), {
    status: "loaded",
    rules: {
      scope: "project",
      content: "- Keep tests with their implementation.",
    },
  });
});

test("distinguishes absent project rules from rules ignored by trust", async (t) => {
  const repositoryRoot = await createRoot(t);

  assert.deepEqual(await loadProjectDiffWalkRules(repositoryRoot, false), {
    status: "absent",
  });

  await writeRules(
    projectRulesPath(repositoryRoot),
    "- Review public contracts first.",
  );
  assert.deepEqual(await loadProjectDiffWalkRules(repositoryRoot, false), {
    status: "ignored-untrusted",
  });
});

test("treats blank review rules as absent", async (t) => {
  const agentDir = await createRoot(t);
  await writeRules(globalRulesPath(agentDir), " \n\t\n");

  assert.deepEqual(await loadGlobalDiffWalkRules(agentDir), {
    status: "absent",
  });
});

test("reports oversized and invalid UTF-8 rules as unavailable", async (t) => {
  const agentDir = await createRoot(t);
  const path = globalRulesPath(agentDir);
  await writeRules(path, Buffer.alloc(MAX_DIFFWALK_RULES_BYTES + 1, "x"));

  const oversized = await loadGlobalDiffWalkRules(agentDir);
  assert.equal(oversized.status, "unavailable");
  if (oversized.status === "unavailable") {
    assert.match(
      oversized.reason,
      new RegExp(`maximum is ${MAX_DIFFWALK_RULES_BYTES} bytes`),
    );
  }

  await writeRules(path, Buffer.from([0xc3, 0x28]));
  const invalid = await loadGlobalDiffWalkRules(agentDir);
  assert.equal(invalid.status, "unavailable");
  if (invalid.status === "unavailable") {
    assert.match(invalid.reason, /not valid UTF-8/);
  }
});

test("reports a non-file rules path as unavailable", async (t) => {
  const agentDir = await createRoot(t);
  await mkdir(globalRulesPath(agentDir), { recursive: true });

  const result = await loadGlobalDiffWalkRules(agentDir);
  assert.equal(result.status, "unavailable");
  if (result.status === "unavailable") {
    assert.match(result.reason, /must be a regular file/);
  }
});
