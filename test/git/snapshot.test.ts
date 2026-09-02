import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertReviewSnapshotUnchanged,
  captureRepositoryState,
  captureReviewSnapshot,
  type GitCommandResult,
  type GitRunner,
  GitSnapshotError,
  ReviewSnapshotDriftError,
} from "../../src/git/snapshot.ts";
import type {
  FileChange,
  ReviewSnapshot,
  TextChange,
} from "../../src/review/types.ts";

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
class MutatingGitRunner implements GitRunner {
  readonly delegate: GitRunner;
  readonly repository: string;
  patchCalls = 0;
  constructor(delegate: GitRunner, repository: string) {
    this.delegate = delegate;
    this.repository = repository;
  }
  async run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.delegate.run(args, cwd);
    if (args.includes("--patch")) {
      this.patchCalls += 1;
      if (this.patchCalls === 3) {
        await writeRepositoryFile(
          this.repository,
          "app.txt",
          "changed during capture\n",
        );
      }
    }
    return result;
  }
}
const gitRunner = new TestGitRunner();
async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await gitRunner.run(args, repository);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
async function writeRepositoryFile(
  repository: string,
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const absolutePath = join(repository, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
async function createRepository(
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = {
    "app.txt": "one\ntwo\nthree\n",
  },
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "pi-diffwalk-test-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "diffwalk@example.com");
  await git(repository, "config", "user.name", "DiffWalk Test");
  await git(repository, "config", "core.filemode", "true");
  for (const [path, content] of Object.entries(files)) {
    await writeRepositoryFile(repository, path, content);
  }
  await git(repository, "add", "--all");
  await git(repository, "commit", "-m", "base");
  await git(repository, "switch", "-c", "feature");
  return repository;
}
function findChange(snapshot: ReviewSnapshot, path: string): FileChange {
  const change = snapshot.changes.find(
    (candidate) => candidate.oldPath === path || candidate.newPath === path,
  );
  assert.ok(change, `Expected a change for ${JSON.stringify(path)}`);
  return change;
}
function textContent(change: FileChange): TextChange {
  assert.equal(change.content.type, "text");
  return change.content as TextChange;
}
interface UnifiedLine {
  readonly type: string;
  readonly raw: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}
/** Renders the frozen whole-file model back into unified diff form. */
function unified(change: FileChange): readonly UnifiedLine[] {
  return textContent(change).lines.map((line) => ({
    type: line.type,
    raw: `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.text}`,
    oldLine: line.oldLine,
    newLine: line.newLine,
  }));
}
function rawLines(change: FileChange): readonly string[] {
  return unified(change).map((line) => line.raw);
}
function changedLines(change: FileChange): readonly UnifiedLine[] {
  return unified(change).filter((line) => line.type !== "context");
}
test("captures an unstaged tracked change with independent old and new line anchors", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "app.txt", "one\nchanged\nthree\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal(snapshot.repositoryRoot, await realpath(repository));
  assert.equal(snapshot.comparison.targetOid, snapshot.comparison.mergeBaseOid);
  assert.equal(snapshot.changes.length, 1);
  const change = findChange(snapshot, "app.txt");
  assert.equal(change.source, "tracked");
  assert.equal(change.status, "modified");
  assert.deepEqual(
    unified(change).map(({ type, raw, oldLine, newLine }) => ({
      type,
      raw,
      oldLine,
      newLine,
    })),
    [
      { type: "context", raw: " one", oldLine: 1, newLine: 1 },
      { type: "removed", raw: "-two", oldLine: 2, newLine: undefined },
      { type: "added", raw: "+changed", oldLine: undefined, newLine: 2 },
      { type: "context", raw: " three", oldLine: 3, newLine: 3 },
    ],
  );
});
test("distinguishes staged, unstaged, and mixed repository states", async (t) => {
  const repository = await createRepository(t, { "value.txt": "base\n" });
  const clean = await captureReviewSnapshot(gitRunner, repository, "main");
  await writeRepositoryFile(repository, "value.txt", "staged\n");
  await git(repository, "add", "value.txt");
  const staged = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.notEqual(
    staged.repositoryState.stagedFingerprint,
    clean.repositoryState.stagedFingerprint,
  );
  assert.equal(
    staged.repositoryState.unstagedFingerprint,
    clean.repositoryState.unstagedFingerprint,
  );
  await writeRepositoryFile(repository, "value.txt", "worktree\n");
  const mixed = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal(
    mixed.repositoryState.stagedFingerprint,
    staged.repositoryState.stagedFingerprint,
  );
  assert.notEqual(
    mixed.repositoryState.unstagedFingerprint,
    staged.repositoryState.unstagedFingerprint,
  );
  const lines = rawLines(findChange(mixed, "value.txt"));
  assert.ok(lines.includes("-base"));
  assert.ok(lines.includes("+worktree"));
  assert.ok(!lines.includes("+staged"));
});
test("captures untracked text and empty files", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "untracked file.txt", "new\n");
  await writeRepositoryFile(repository, "empty.txt", "");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const text = findChange(snapshot, "untracked file.txt");
  assert.equal(text.source, "untracked");
  assert.equal(text.status, "added");
  assert.equal(text.content.type, "text");
  const empty = findChange(snapshot, "empty.txt");
  assert.equal(empty.source, "untracked");
  assert.equal(empty.status, "added");
  assert.equal(empty.content.type, "metadata-only");
});
test("captures staged added and deleted files", async (t) => {
  const repository = await createRepository(t, {
    "delete.txt": "delete me\n",
    "keep.txt": "keep\n",
  });
  await writeRepositoryFile(repository, "added.txt", "added\n");
  await unlink(join(repository, "delete.txt"));
  await git(repository, "add", "--all");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal(findChange(snapshot, "added.txt").status, "added");
  assert.equal(findChange(snapshot, "delete.txt").status, "deleted");
});
test("captures exact renames and copies", async (t) => {
  const repository = await createRepository(t, {
    "rename-source.txt": "rename\ncontent\n",
    "copy-source.txt": "copy\ncontent\n",
  });
  await git(repository, "mv", "rename-source.txt", "renamed.txt");
  await copyFile(
    join(repository, "copy-source.txt"),
    join(repository, "copied.txt"),
  );
  await git(repository, "add", "--all");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const renamed = findChange(snapshot, "renamed.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "rename-source.txt");
  assert.equal(renamed.content.type, "metadata-only");
  const copied = findChange(snapshot, "copied.txt");
  assert.equal(copied.status, "copied");
  assert.equal(copied.oldPath, "copy-source.txt");
});
test("reports binary files without inventing text hunks", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(
    repository,
    "binary.dat",
    new Uint8Array([0, 1, 2, 3, 255]),
  );
  await git(repository, "add", "binary.dat");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const change = findChange(snapshot, "binary.dat");
  assert.equal(change.content.type, "binary");
  assert.ok(change.content.gitBodyLines.includes("GIT binary patch"));
  assert.match(change.content.unsupportedReason, /Binary/);
});
test("records a missing trailing newline per side instead of as a phantom line", async (t) => {
  const repository = await createRepository(t, { "no-newline.txt": "old" });
  await writeRepositoryFile(repository, "no-newline.txt", "new");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const content = textContent(findChange(snapshot, "no-newline.txt"));
  assert.equal(content.oldNoTrailingNewline, true);
  assert.equal(content.newNoTrailingNewline, true);
  assert.deepEqual(rawLines(findChange(snapshot, "no-newline.txt")), [
    "-old",
    "+new",
  ]);
});
test("keeps a trailing newline flag false when only one side loses it", async (t) => {
  const repository = await createRepository(t, { "tail.txt": "one\ntwo\n" });
  await writeRepositoryFile(repository, "tail.txt", "one\ntwo");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const content = textContent(findChange(snapshot, "tail.txt"));
  assert.equal(content.oldNoTrailingNewline, false);
  assert.equal(content.newNoTrailingNewline, true);
});
test("preserves paths containing spaces, Unicode, and newlines", async (t) => {
  const paths = ["folder/space name.txt", "路径/文件.txt", "line\nbreak.txt"];
  const repository = await createRepository(
    t,
    Object.fromEntries(paths.map((path) => [path, "old\n"])),
  );
  for (const path of paths)
    await writeRepositoryFile(repository, path, "new\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  for (const path of paths) {
    const change = findChange(snapshot, path);
    assert.equal(change.oldPath, path);
    assert.equal(change.newPath, path);
    assert.equal(change.content.type, "text");
  }
});
test("parses multiple hunks and keeps an unchanged hunk fingerprint across line shifts", async (t) => {
  const original = Array.from(
    { length: 30 },
    (_, index) => `line ${index + 1}`,
  );
  const repository = await createRepository(t, {
    "many.txt": `${original.join("\n")}\n`,
  });
  const first = [...original];
  first[19] = "changed twenty";
  await writeRepositoryFile(repository, "many.txt", `${first.join("\n")}\n`);
  const firstSnapshot = await captureReviewSnapshot(
    gitRunner,
    repository,
    "main",
  );
  const firstChange = findChange(firstSnapshot, "many.txt");
  const second = ["inserted first", ...first];
  await writeRepositoryFile(repository, "many.txt", `${second.join("\n")}\n`);
  const secondSnapshot = await captureReviewSnapshot(
    gitRunner,
    repository,
    "main",
  );
  const secondChange = findChange(secondSnapshot, "many.txt");
  // The reviewed line keeps its text and side while its number shifts by one,
  // which is what carries a review decision across rounds.
  assert.deepEqual(
    changedLines(firstChange).map((line) => [
      line.type,
      line.raw,
      line.newLine,
    ]),
    [
      ["removed", "-line 20", undefined],
      ["added", "+changed twenty", 20],
    ],
  );
  assert.deepEqual(
    changedLines(secondChange).map((line) => [
      line.type,
      line.raw,
      line.newLine,
    ]),
    [
      ["added", "+inserted first", 1],
      ["removed", "-line 20", undefined],
      ["added", "+changed twenty", 21],
    ],
  );
  assert.equal(textContent(secondChange).newLineCount, 31);
  assert.equal(textContent(secondChange).oldLineCount, 30);
});
test("keeps changed-line identity when an untracked file becomes staged", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "new-file.txt", "new content\n");
  const untracked = await captureReviewSnapshot(gitRunner, repository, "main");
  const untrackedChange = findChange(untracked, "new-file.txt");
  await git(repository, "add", "new-file.txt");
  const staged = await captureReviewSnapshot(gitRunner, repository, "main");
  const stagedChange = findChange(staged, "new-file.txt");
  assert.equal(untrackedChange.source, "untracked");
  assert.equal(stagedChange.source, "tracked");
  assert.deepEqual(rawLines(stagedChange), rawLines(untrackedChange));
  assert.deepEqual(
    changedLines(stagedChange).map((line) => [line.type, line.raw]),
    [["added", "+new content"]],
  );
});
test("captures mode-only and file type changes", async (t) => {
  const repository = await createRepository(t, {
    "mode.txt": "mode\n",
    "type.txt": "target\n",
  });
  await chmod(join(repository, "mode.txt"), 0o755);
  await unlink(join(repository, "type.txt"));
  await symlink("mode.txt", join(repository, "type.txt"));
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const mode = findChange(snapshot, "mode.txt");
  assert.equal(mode.status, "mode-changed");
  assert.equal(mode.oldMode, "100644");
  assert.equal(mode.newMode, "100755");
  assert.equal(mode.content.type, "metadata-only");
  const type = findChange(snapshot, "type.txt");
  assert.equal(type.status, "type-changed");
  assert.equal(type.oldMode, "100644");
  assert.equal(type.newMode, "120000");
});
test("reports staged and unstaged changes that cancel in the effective worktree", async (t) => {
  const repository = await createRepository(t, {
    "cancelled.txt": "original\n",
  });
  await writeRepositoryFile(repository, "cancelled.txt", "staged\n");
  await git(repository, "add", "cancelled.txt");
  await writeRepositoryFile(repository, "cancelled.txt", "original\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal(snapshot.changes.length, 0);
  assert.deepEqual(
    snapshot.notices.map(({ type, filePath }) => ({ type, filePath })),
    [{ type: "cancelled-layer-change", filePath: "cancelled.txt" }],
  );
});
test("reports unmerged files as unsupported changes", async (t) => {
  const repository = await createRepository(t, { "conflict.txt": "base\n" });
  await writeRepositoryFile(repository, "conflict.txt", "feature\n");
  await git(repository, "add", "conflict.txt");
  await git(repository, "commit", "-m", "feature change");
  await git(repository, "switch", "main");
  await writeRepositoryFile(repository, "conflict.txt", "main\n");
  await git(repository, "add", "conflict.txt");
  await git(repository, "commit", "-m", "main change");
  await git(repository, "switch", "feature");
  const merge = await gitRunner.run(["merge", "main"], repository);
  assert.notEqual(merge.code, 0);
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const change = findChange(snapshot, "conflict.txt");
  assert.equal(change.status, "unmerged");
  assert.equal(change.content.type, "unsupported");
  assert.match(change.content.unsupportedReason, /Unmerged/);
});
test("compares the merge base to branch commits plus the effective worktree", async (t) => {
  const repository = await createRepository(t, { "branch.txt": "base\n" });
  await writeRepositoryFile(repository, "branch.txt", "committed\n");
  await git(repository, "add", "branch.txt");
  await git(repository, "commit", "-m", "branch change");
  await writeRepositoryFile(repository, "branch.txt", "worktree\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const lines = rawLines(findChange(snapshot, "branch.txt"));
  assert.equal(snapshot.comparison.targetOid, snapshot.comparison.mergeBaseOid);
  assert.notEqual(
    snapshot.comparison.sourceHeadOid,
    snapshot.comparison.targetOid,
  );
  assert.ok(lines.includes("-base"));
  assert.ok(lines.includes("+worktree"));
  assert.ok(!lines.includes("+committed"));
});
test("produces deterministic identifiers and detects later repository state", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "app.txt", "one\nchanged\nthree\n");
  const first = await captureReviewSnapshot(gitRunner, repository, "main");
  const second = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.deepEqual(second, first);
  await writeRepositoryFile(
    repository,
    "app.txt",
    "one\nchanged again\nthree\n",
  );
  const third = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.notEqual(third.id, first.id);
  assert.notEqual(
    third.repositoryState.unstagedFingerprint,
    first.repositoryState.unstagedFingerprint,
  );
});
test("captures the source branch and detached HEAD in the comparison", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "app.txt", "one\nchanged\nthree\n");
  const onBranch = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal(onBranch.comparison.sourceBranch, "feature");
  await git(repository, "switch", "--detach", "HEAD");
  const detached = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.equal("sourceBranch" in detached.comparison, false);
  assert.equal(detached.id, onBranch.id);
});
test("recaptures the repository state stored in a review snapshot", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "app.txt", "one\nchanged\nthree\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  assert.deepEqual(
    await captureRepositoryState(gitRunner, repository),
    snapshot.repositoryState,
  );
  await assert.doesNotReject(
    assertReviewSnapshotUnchanged(gitRunner, snapshot),
  );
});
test("blocks comment submission when the repository drifts after capture", async (t) => {
  const repository = await createRepository(t);
  await writeRepositoryFile(repository, "app.txt", "one\nreviewed\nthree\n");
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  await writeRepositoryFile(repository, "app.txt", "one\ndrifted\nthree\n");
  await assert.rejects(
    assertReviewSnapshotUnchanged(gitRunner, snapshot),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSnapshotDriftError);
      assert.ok(error instanceof GitSnapshotError);
      assert.match(error.message, /repository changed after review snapshot/);
      assert.match(error.message, /Comments were not submitted/);
      return true;
    },
  );
});
test("keeps Git verification failures distinct from repository drift", async (t) => {
  const repository = await createRepository(t);
  const snapshot = await captureReviewSnapshot(gitRunner, repository, "main");
  const failingRunner: GitRunner = {
    run: async () => ({
      stdout: "",
      stderr: "repository unavailable",
      code: 128,
    }),
  };
  await assert.rejects(
    assertReviewSnapshotUnchanged(failingRunner, snapshot),
    (error: unknown) => {
      assert.ok(error instanceof GitSnapshotError);
      assert.equal(error instanceof ReviewSnapshotDriftError, false);
      assert.match(error.message, /repository unavailable/);
      return true;
    },
  );
});
test("rejects a snapshot when the repository drifts during capture", async (t) => {
  const repository = await createRepository(t);
  const mutatingRunner = new MutatingGitRunner(gitRunner, repository);
  await assert.rejects(
    captureReviewSnapshot(mutatingRunner, repository, "main"),
    /The repository changed while DiffWalk was capturing the review snapshot/,
  );
});
test("returns an actionable error for an unknown review target", async (t) => {
  const repository = await createRepository(t);
  await assert.rejects(
    captureReviewSnapshot(gitRunner, repository, "missing-target"),
    (error: unknown) => {
      assert.ok(error instanceof GitSnapshotError);
      assert.match(error.message, /Unable to resolve review target/);
      assert.ok(error.args?.includes("missing-target^{commit}"));
      return true;
    },
  );
});
