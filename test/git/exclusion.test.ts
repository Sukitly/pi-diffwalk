import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitSnapshotError } from "../../src/git/errors.ts";
import { resolvePathExclusionFacts } from "../../src/git/exclusion.ts";
import type { GitCommandResult, GitRunner } from "../../src/git/runner.ts";
import { captureReviewSnapshot } from "../../src/git/snapshot.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import {
  computeExclusions,
  exclusionPath,
} from "../../src/review/exclusion.ts";

class TestGitRunner implements GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code: code ?? 1,
          killed: signal !== null,
        });
      });
    });
  }
}

const gitRunner = new TestGitRunner();

async function writeRepositoryFile(
  repository: string,
  path: string,
  content: string,
): Promise<void> {
  const absolutePath = join(repository, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function createRepository(
  t: TestContext,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "pi-diffwalk-exclusion-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const init = await gitRunner.run(
    ["init", "--initial-branch=main"],
    repository,
  );
  assert.equal(init.code, 0, init.stderr);
  for (const [path, content] of Object.entries(files)) {
    await writeRepositoryFile(repository, path, content);
  }
  return repository;
}

test("matches only patterns from the DiffWalk exclude file, honoring negation", async (t) => {
  const repository = await createRepository(t, {
    ".gitignore": "ignored-by-repo.txt\n",
    exclude: "*.lock\n!keep.lock\ndist/\n",
  });
  const excludeFile = join(repository, "exclude");

  const facts = await resolvePathExclusionFacts(
    gitRunner,
    repository,
    [
      "a.lock",
      "keep.lock",
      "dist/bundle.js",
      "src/app.ts",
      "ignored-by-repo.txt",
      "deleted/never-existed.lock",
      "dir with space/x.lock",
      '中文/q"uote.lock',
    ],
    { excludeFile, generatedAttribute: false },
  );

  assert.deepEqual([...facts.excludedPaths.entries()].sort(), [
    ["a.lock", "*.lock"],
    ["deleted/never-existed.lock", "*.lock"],
    ["dir with space/x.lock", "*.lock"],
    ["dist/bundle.js", "dist/"],
    ['中文/q"uote.lock', "*.lock"],
  ]);
  assert.equal(facts.generatedPaths.size, 0);
});

test("reads linguist-generated from Git attributes", async (t) => {
  const repository = await createRepository(t, {
    ".gitattributes": [
      "gen/* linguist-generated",
      "vendor/** linguist-generated=true",
      "src/plain.ts -linguist-generated",
    ].join("\n"),
  });

  const facts = await resolvePathExclusionFacts(
    gitRunner,
    repository,
    ["gen/schema.ts", "vendor/lib/x.js", "src/plain.ts", "src/app.ts"],
    { generatedAttribute: true },
  );

  assert.deepEqual([...facts.generatedPaths].sort(), [
    "gen/schema.ts",
    "vendor/lib/x.js",
  ]);
  assert.equal(facts.excludedPaths.size, 0);
});

test("returns nothing when no source is enabled or no path matches", async (t) => {
  const repository = await createRepository(t, { exclude: "*.lock\n" });

  const disabled = await resolvePathExclusionFacts(
    gitRunner,
    repository,
    ["a.lock"],
    { generatedAttribute: false },
  );
  assert.equal(disabled.excludedPaths.size, 0);
  assert.equal(disabled.generatedPaths.size, 0);

  const unmatched = await resolvePathExclusionFacts(
    gitRunner,
    repository,
    ["src/app.ts"],
    { excludeFile: join(repository, "exclude"), generatedAttribute: true },
  );
  assert.equal(unmatched.excludedPaths.size, 0);
  assert.equal(unmatched.generatedPaths.size, 0);
});

test("batches long path lists and deduplicates them", async (t) => {
  const repository = await createRepository(t, { exclude: "*.lock\n" });
  const paths = Array.from({ length: 450 }, (_, index) =>
    index % 3 === 0 ? `file-${index}.lock` : `file-${index}.ts`,
  );

  const facts = await resolvePathExclusionFacts(
    gitRunner,
    repository,
    [...paths, ...paths],
    { excludeFile: join(repository, "exclude"), generatedAttribute: false },
  );

  assert.equal(facts.excludedPaths.size, 150);
});

test("reports a Git failure as a GitSnapshotError", async () => {
  const failing: GitRunner = {
    async run() {
      return { stdout: "", stderr: "boom", code: 128, killed: false };
    },
  };

  await assert.rejects(
    resolvePathExclusionFacts(failing, "/repo", ["a.lock"], {
      excludeFile: "/tmp/exclude",
      generatedAttribute: false,
    }),
    GitSnapshotError,
  );
});

test("end to end: snapshot paths, Git facts, and exclusions agree on a real repository", async (t) => {
  const repository = await createRepository(t, {
    ".gitattributes": "gen/** linguist-generated=true\n",
    exclude: "*.lock\n",
    "a.lock": "old\n",
    "gen/out.ts": "export const gen = 1;\n",
    "src/app 中文.ts": "const x  = 1;\nkeep\nreal\n",
    "src/keep.ts": "unchanged\n",
  });
  const commit = async (...args: string[]) => {
    const result = await gitRunner.run(args, repository);
    assert.equal(result.code, 0, result.stderr);
  };
  await commit("config", "user.email", "diffwalk@example.com");
  await commit("config", "user.name", "DiffWalk Test");
  await commit("add", "--all");
  await commit("commit", "-q", "-m", "base");
  await writeRepositoryFile(repository, "a.lock", "new\n");
  await writeRepositoryFile(
    repository,
    "gen/out.ts",
    "export const gen = 2;\n",
  );
  await writeRepositoryFile(
    repository,
    "src/app 中文.ts",
    "const x = 1;\nkeep\nchanged\n",
  );

  const snapshot = await captureReviewSnapshot(gitRunner, repository, "HEAD");
  const paths = snapshot.changes
    .map((change) => exclusionPath(change))
    .filter((path): path is string => path !== undefined);
  const facts = await resolvePathExclusionFacts(gitRunner, repository, paths, {
    excludeFile: join(repository, "exclude"),
    generatedAttribute: true,
  });
  const delta = computeReviewDelta(snapshot, undefined, {
    exclusions: computeExclusions(snapshot, facts),
  });

  const byPath = new Map<string, string[]>();
  for (const requirement of delta.lines) {
    const change = snapshot.changes.find(
      (candidate) => candidate.id === requirement.fileChangeId,
    );
    assert.ok(change);
    const path = exclusionPath(change) ?? "";
    const label =
      requirement.type === "excluded"
        ? `${requirement.side}:${requirement.line}=${requirement.reason}`
        : `${requirement.side}:${requirement.line}=${requirement.type}`;
    byPath.set(path, [...(byPath.get(path) ?? []), label]);
  }
  assert.deepEqual(Object.fromEntries([...byPath.entries()].sort()), {
    "a.lock": ["old:1=excluded-path", "new:1=excluded-path"],
    "gen/out.ts": ["old:1=generated-attribute", "new:1=generated-attribute"],
    "src/app 中文.ts": [
      "old:1=whitespace-only",
      "new:1=whitespace-only",
      "old:3=needs-review",
      "new:3=needs-review",
    ],
  });
});
