import type { GitObjectId } from "../review/types.ts";
import { GitSnapshotError } from "./errors.ts";

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed?: boolean;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export const DIFF_CONFIG = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.renameLimit=0",
] as const;

const DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--ignore-submodules=none",
  "--find-renames=50%",
  "--find-copies=50%",
  "--find-copies-harder",
  "--diff-algorithm=myers",
] as const;

export const PATCH_OPTIONS = [
  ...DIFF_OPTIONS,
  "--patch",
  "--binary",
  "--full-index",
  "--unified=3",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

export const RAW_OPTIONS = [
  ...DIFF_OPTIONS,
  "--raw",
  "-z",
  "--full-index",
] as const;

export async function resolveRepositoryRoot(
  git: GitRunner,
  cwd: string,
): Promise<string> {
  const output = await runGit(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  const root = stripLineTerminator(output);
  if (root.length === 0) {
    throw new GitSnapshotError("Git returned an empty repository root.");
  }
  return root;
}

export async function resolveCommit(
  git: GitRunner,
  repositoryRoot: string,
  revision: string,
  label: string,
): Promise<GitObjectId> {
  const args = [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ];
  const output = await runGit(
    git,
    repositoryRoot,
    args,
    [0],
    `Unable to resolve ${label} ${JSON.stringify(revision)}.`,
  );
  return parseObjectId(output, label);
}

export async function resolveSourceBranch(
  git: GitRunner,
  repositoryRoot: string,
): Promise<string | undefined> {
  const args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
  const result = await git.run(args, repositoryRoot);
  if (result.killed || (result.code !== 0 && result.code !== 1)) {
    const detail = result.stderr.trim();
    throw new GitSnapshotError(
      detail.length > 0
        ? `Unable to identify the review source branch. ${detail}`
        : "Unable to identify the review source branch.",
      args,
    );
  }
  if (result.code === 1) return undefined;
  const branch = stripLineTerminator(result.stdout);
  if (branch.length === 0) {
    throw new GitSnapshotError(
      "Git returned an empty source branch name.",
      args,
    );
  }
  return branch;
}

export async function resolveMergeBase(
  git: GitRunner,
  repositoryRoot: string,
  targetOid: GitObjectId,
  sourceHeadOid: GitObjectId,
): Promise<GitObjectId> {
  const output = await runGit(
    git,
    repositoryRoot,
    ["merge-base", targetOid, sourceHeadOid],
    [0],
    `Unable to find a merge base between ${targetOid} and ${sourceHeadOid}.`,
  );
  return parseObjectId(output, "merge base");
}

function parseObjectId(output: string, label: string): GitObjectId {
  const value = stripLineTerminator(output).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new GitSnapshotError(
      `Git returned an invalid ${label} object ID: ${JSON.stringify(value)}.`,
    );
  }
  return value as GitObjectId;
}

export function diffArgs(
  options: readonly string[],
  revisions: readonly string[],
): readonly string[] {
  return [...DIFF_CONFIG, "diff", ...options, ...revisions, "--"];
}

export async function runGit(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
  allowedCodes: readonly number[] = [0],
  failureMessage = "Git command failed.",
): Promise<string> {
  const result = await git.run(args, cwd);
  if (result.killed || !allowedCodes.includes(result.code)) {
    const detail = result.stderr.trim();
    throw new GitSnapshotError(
      detail.length > 0 ? `${failureMessage} ${detail}` : failureMessage,
      args,
    );
  }
  return result.stdout;
}

function stripLineTerminator(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
