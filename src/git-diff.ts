import { createHash } from "node:crypto";
import type {
  BinaryChange,
  DiffLine,
  FileChange,
  FileChangeContent,
  FileChangeId,
  FileChangeSource,
  FileChangeStatus,
  GitObjectId,
  MetadataOnlyChange,
  NoticeId,
  RepositoryState,
  ReviewSnapshot,
  ReviewSpan,
  SnapshotId,
  SnapshotNotice,
  StateFingerprint,
  TextChange,
  UnsupportedChange,
} from "./types.ts";

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed?: boolean;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitCommandResult>;
}

export class GitSnapshotError extends Error {
  readonly args?: readonly string[];

  constructor(message: string, args?: readonly string[]) {
    super(message);
    this.name = "GitSnapshotError";
    this.args = args;
  }
}

export class ReviewSnapshotDriftError extends GitSnapshotError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSnapshotDriftError";
  }
}

interface RawFileChange {
  readonly statusCode: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly oldPath?: string;
  readonly newPath?: string;
}

interface RepositoryStateArtifacts {
  readonly state: RepositoryState;
  readonly untrackedFiles: readonly UntrackedFile[];
}

interface StateArtifacts extends RepositoryStateArtifacts {
  readonly stagedChanges: readonly RawFileChange[];
  readonly unstagedChanges: readonly RawFileChange[];
  readonly headWorktreeChanges: readonly RawFileChange[];
}

interface UntrackedFile {
  readonly path: string;
  readonly patch: string;
}

/** Unified diff hunk header. Hunks are an internal parsing artifact only. */
interface HunkHeader {
  readonly raw: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

type ParsedLineKind = "context" | "added" | "removed" | "no-newline-marker";

interface ParsedLine {
  readonly kind: ParsedLineKind;
  readonly raw: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

interface HunkDraft {
  readonly header: HunkHeader;
  readonly lines: readonly ParsedLine[];
}

type ContentDraft =
  | {
      readonly kind: "text";
      readonly hunks: readonly HunkDraft[];
    }
  | BinaryChange
  | MetadataOnlyChange
  | UnsupportedChange;

interface PatchDraft {
  readonly gitHeaderLines: readonly string[];
  readonly content: ContentDraft;
}

interface FileChangeDraft {
  readonly source: FileChangeSource;
  readonly status: FileChangeStatus;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly gitHeaderLines: readonly string[];
  readonly content: ContentDraft;
}

const DIFF_CONFIG = [
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

const PATCH_OPTIONS = [
  ...DIFF_OPTIONS,
  "--patch",
  "--binary",
  "--full-index",
  "--unified=3",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

const RAW_OPTIONS = [...DIFF_OPTIONS, "--raw", "-z", "--full-index"] as const;

export async function captureRepositoryState(
  git: GitRunner,
  cwd: string,
): Promise<RepositoryState> {
  const repositoryRoot = await resolveRepositoryRoot(git, cwd);
  return (await captureRepositoryStateArtifacts(git, repositoryRoot)).state;
}

export async function assertReviewSnapshotUnchanged(
  git: GitRunner,
  snapshot: ReviewSnapshot,
): Promise<void> {
  const currentState = await captureRepositoryState(
    git,
    snapshot.repositoryRoot,
  );
  if (!sameRepositoryState(snapshot.repositoryState, currentState)) {
    throw new ReviewSnapshotDriftError(
      `The repository changed after review snapshot ${snapshot.id} was captured. Comments were not submitted.`,
    );
  }
}

export async function captureReviewSnapshot(
  git: GitRunner,
  cwd: string,
  targetRef: string,
): Promise<ReviewSnapshot> {
  if (targetRef.length === 0) {
    throw new GitSnapshotError("A review target ref is required.");
  }

  const repositoryRoot = await resolveRepositoryRoot(git, cwd);
  const targetOid = await resolveCommit(
    git,
    repositoryRoot,
    targetRef,
    "review target",
  );
  const before = await captureStateArtifacts(git, repositoryRoot);
  const sourceBranch = await resolveSourceBranch(git, repositoryRoot);
  const mergeBaseOid = await resolveMergeBase(
    git,
    repositoryRoot,
    targetOid,
    before.state.headOid,
  );

  const trackedRaw = await runGit(
    git,
    repositoryRoot,
    diffArgs(RAW_OPTIONS, [mergeBaseOid]),
  );
  const trackedPatch = await runGit(
    git,
    repositoryRoot,
    diffArgs(PATCH_OPTIONS, [mergeBaseOid]),
  );

  const unmergedPaths = collectPaths(
    [...before.stagedChanges, ...before.unstagedChanges].filter(
      (change) => change.statusCode === "U",
    ),
  );
  const trackedDrafts = buildTrackedDrafts(
    parseRawDiff(trackedRaw),
    splitPatchBlocks(trackedPatch),
    unmergedPaths,
  );
  const untrackedDrafts = before.untrackedFiles.map(buildUntrackedDraft);
  const built: FileChange[] = [];
  for (const draft of [...trackedDrafts, ...untrackedDrafts]) {
    built.push(await buildFileChange(git, repositoryRoot, mergeBaseOid, draft));
  }
  const changes = built.sort(compareFileChanges);
  const notices = buildCancelledLayerNotices(before, changes);

  const after = await captureStateArtifacts(git, repositoryRoot);
  if (!sameRepositoryState(before.state, after.state)) {
    throw new GitSnapshotError(
      "The repository changed while DiffWalk was capturing the review snapshot. Retry the review.",
    );
  }

  const comparison = {
    targetRef,
    targetOid,
    sourceHeadOid: before.state.headOid,
    mergeBaseOid,
    ...(sourceBranch === undefined ? {} : { sourceBranch }),
  };
  const id = hashAs<SnapshotId>("snapshot", {
    comparison: {
      targetOid,
      sourceHeadOid: before.state.headOid,
      mergeBaseOid,
    },
    repositoryState: before.state,
    changes,
    notices,
  });

  return {
    id,
    repositoryRoot,
    comparison,
    repositoryState: before.state,
    changes,
    notices,
  };
}

async function resolveRepositoryRoot(
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

async function resolveCommit(
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

async function resolveSourceBranch(
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

async function resolveMergeBase(
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

async function captureRepositoryStateArtifacts(
  git: GitRunner,
  repositoryRoot: string,
): Promise<RepositoryStateArtifacts> {
  const headOid = await resolveCommit(
    git,
    repositoryRoot,
    "HEAD",
    "source HEAD",
  );
  const stagedPatch = await runGit(
    git,
    repositoryRoot,
    diffArgs(PATCH_OPTIONS, ["--cached", headOid]),
  );
  const unstagedPatch = await runGit(
    git,
    repositoryRoot,
    diffArgs(PATCH_OPTIONS, []),
  );
  const untrackedFiles = await captureUntrackedFiles(git, repositoryRoot);

  return {
    state: {
      headOid,
      stagedFingerprint: hashAs<StateFingerprint>("staged-state", stagedPatch),
      unstagedFingerprint: hashAs<StateFingerprint>(
        "unstaged-state",
        unstagedPatch,
      ),
      untrackedFingerprint: hashAs<StateFingerprint>(
        "untracked-state",
        untrackedFiles,
      ),
    },
    untrackedFiles,
  };
}

async function captureStateArtifacts(
  git: GitRunner,
  repositoryRoot: string,
): Promise<StateArtifacts> {
  const repositoryState = await captureRepositoryStateArtifacts(
    git,
    repositoryRoot,
  );
  const stagedRaw = await runGit(
    git,
    repositoryRoot,
    diffArgs(RAW_OPTIONS, ["--cached", repositoryState.state.headOid]),
  );
  const unstagedRaw = await runGit(
    git,
    repositoryRoot,
    diffArgs(RAW_OPTIONS, []),
  );
  const headWorktreeRaw = await runGit(
    git,
    repositoryRoot,
    diffArgs(RAW_OPTIONS, [repositoryState.state.headOid]),
  );

  return {
    ...repositoryState,
    stagedChanges: parseRawDiff(stagedRaw),
    unstagedChanges: parseRawDiff(unstagedRaw),
    headWorktreeChanges: parseRawDiff(headWorktreeRaw),
  };
}

async function captureUntrackedFiles(
  git: GitRunner,
  repositoryRoot: string,
): Promise<readonly UntrackedFile[]> {
  const output = await runGit(git, repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--full-name",
    "-z",
    "--",
  ]);
  const paths = splitNul(output).sort(compareStringsByUtf8);
  const files: UntrackedFile[] = [];

  for (const path of paths) {
    const args = [
      ...DIFF_CONFIG,
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "--diff-algorithm=myers",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      "/dev/null",
      `./${path}`,
    ];
    const patch = await runGit(
      git,
      repositoryRoot,
      args,
      [0, 1],
      `Unable to capture untracked file ${JSON.stringify(path)}.`,
    );
    if (patch.length === 0) {
      throw new GitSnapshotError(
        `Git produced no patch inventory for untracked file ${JSON.stringify(path)}.`,
        args,
      );
    }
    files.push({ path, patch });
  }

  return files;
}

function diffArgs(
  options: readonly string[],
  revisions: readonly string[],
): readonly string[] {
  return [...DIFF_CONFIG, "diff", ...options, ...revisions, "--"];
}

async function runGit(
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

function parseRawDiff(output: string): readonly RawFileChange[] {
  if (output.length === 0) return [];

  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: RawFileChange[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = requiredAt(fields, index, "raw diff header");
    index += 1;
    const match =
      /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    if (!match) {
      throw new GitSnapshotError(
        `Unable to parse Git raw diff header ${JSON.stringify(header)}.`,
      );
    }

    const oldModeValue = requiredAt(match, 1, "raw diff old mode");
    const newModeValue = requiredAt(match, 2, "raw diff new mode");
    const statusCode = requiredAt(match, 3, "raw diff status");
    const firstPath = requiredAt(fields, index, "raw diff path");
    index += 1;

    if (statusCode === "R" || statusCode === "C") {
      const secondPath = requiredAt(fields, index, "raw diff destination path");
      index += 1;
      changes.push({
        statusCode,
        oldMode: normalizeMode(oldModeValue),
        newMode: normalizeMode(newModeValue),
        oldPath: firstPath,
        newPath: secondPath,
      });
      continue;
    }

    changes.push({
      statusCode,
      oldMode: normalizeMode(oldModeValue),
      newMode: normalizeMode(newModeValue),
      oldPath: statusCode === "A" ? undefined : firstPath,
      newPath: statusCode === "D" ? undefined : firstPath,
    });
  }

  return changes;
}

function normalizeMode(mode: string): string | undefined {
  return mode === "000000" ? undefined : mode;
}

function splitPatchBlocks(output: string): readonly (readonly string[])[] {
  if (output.length === 0) return [];
  const lines = splitLines(output);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (requiredAt(lines, index, "patch line").startsWith("diff --git "))
      starts.push(index);
  }
  return starts.map((start, index) =>
    lines.slice(start, starts[index + 1] ?? lines.length),
  );
}

function splitLines(output: string): readonly string[] {
  const withoutFinalNewline = output.endsWith("\n")
    ? output.slice(0, -1)
    : output;
  return withoutFinalNewline.length === 0
    ? []
    : withoutFinalNewline.split("\n");
}

function splitNul(output: string): string[] {
  if (output.length === 0) return [];
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function buildTrackedDrafts(
  records: readonly RawFileChange[],
  blocks: readonly (readonly string[])[],
  unmergedPaths: ReadonlySet<string>,
): readonly FileChangeDraft[] {
  const blockGroups = groupPatchBlocksByHeader(blocks);
  if (records.length !== blockGroups.length) {
    const reason = `Git reported ${records.length} file changes but produced ${blockGroups.length} distinct patch block groups. DiffWalk cannot match the patch blocks safely.`;
    return records.map((record) =>
      buildUnsupportedDraft(record, "tracked", reason),
    );
  }

  return records.map((record, index) => {
    const effectiveRecord = recordTouchesPaths(record, unmergedPaths)
      ? { ...record, statusCode: "U" }
      : record;
    return buildDraft(
      effectiveRecord,
      "tracked",
      parsePatchBlocks(
        requiredAt(blockGroups, index, "tracked patch block group"),
      ),
    );
  });
}

function groupPatchBlocksByHeader(
  blocks: readonly (readonly string[])[],
): readonly (readonly (readonly string[])[])[] {
  const groups: (readonly string[])[][] = [];
  for (const block of blocks) {
    const header = requiredAt(block, 0, "patch block header");
    const previous = groups.at(-1);
    if (
      previous !== undefined &&
      requiredAt(previous.at(-1) ?? [], 0, "patch block header") === header
    ) {
      previous.push(block);
    } else {
      groups.push([block]);
    }
  }
  return groups;
}

function parsePatchBlocks(blocks: readonly (readonly string[])[]): PatchDraft {
  const drafts = blocks.map(parsePatchBlock);
  if (drafts.length === 1) return requiredAt(drafts, 0, "parsed patch block");

  const gitHeaderLines = drafts.flatMap((draft) => draft.gitHeaderLines);
  if (drafts.every((draft) => draft.content.kind === "text")) {
    return {
      gitHeaderLines,
      content: {
        kind: "text",
        hunks: drafts.flatMap((draft) =>
          draft.content.kind === "text" ? draft.content.hunks : [],
        ),
      },
    };
  }

  return {
    gitHeaderLines,
    content: {
      kind: "unsupported",
      gitBodyLines: drafts.flatMap((draft) => contentBodyLines(draft.content)),
      unsupportedReason:
        "This file type change contains incompatible patch formats.",
    },
  };
}

function buildUntrackedDraft(file: UntrackedFile): FileChangeDraft {
  const blocks = splitPatchBlocks(file.patch);
  if (blocks.length !== 1) {
    return buildUnsupportedDraft(
      {
        statusCode: "A",
        newPath: file.path,
      },
      "untracked",
      `Git produced ${blocks.length} patch blocks for one untracked file.`,
    );
  }

  const patch = parsePatchBlock(requiredAt(blocks, 0, "untracked patch block"));
  const newMode = patch.gitHeaderLines
    .map((line) => /^new file mode ([0-7]{6})$/.exec(line)?.[1])
    .find((mode) => mode !== undefined);
  return buildDraft(
    {
      statusCode: "A",
      newMode,
      newPath: file.path,
    },
    "untracked",
    patch,
  );
}

function buildUnsupportedDraft(
  record: RawFileChange,
  source: FileChangeSource,
  reason: string,
): FileChangeDraft {
  return buildDraft(record, source, {
    gitHeaderLines: [],
    content: {
      kind: "unsupported",
      gitBodyLines: [],
      unsupportedReason: reason,
    },
  });
}

function buildDraft(
  record: RawFileChange,
  source: FileChangeSource,
  patch: PatchDraft,
): FileChangeDraft {
  let content = patch.content;
  if (record.statusCode === "U" || record.statusCode === "X") {
    content = {
      kind: "unsupported",
      gitBodyLines: contentBodyLines(patch.content),
      unsupportedReason:
        record.statusCode === "U"
          ? "Unmerged Git changes are not supported."
          : "Git reported an unknown file change status.",
    };
  } else if (record.oldMode === "160000" || record.newMode === "160000") {
    content = {
      kind: "unsupported",
      gitBodyLines: contentBodyLines(patch.content),
      unsupportedReason: "Gitlink changes are not supported.",
    };
  }

  return {
    source,
    status: mapFileStatus(record, content),
    oldPath: record.oldPath,
    newPath: record.newPath,
    oldMode: record.oldMode,
    newMode: record.newMode,
    gitHeaderLines: patch.gitHeaderLines,
    content,
  };
}

function mapFileStatus(
  record: RawFileChange,
  content: ContentDraft,
): FileChangeStatus {
  switch (record.statusCode) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    case "X":
      return "unknown";
    case "M":
      return record.oldMode !== record.newMode &&
        content.kind === "metadata-only"
        ? "mode-changed"
        : "modified";
    default:
      throw new GitSnapshotError(
        `Git reported unsupported file status ${JSON.stringify(record.statusCode)}.`,
      );
  }
}

function parsePatchBlock(lines: readonly string[]): PatchDraft {
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const binaryStart = lines.findIndex(
    (line) => line === "GIT binary patch" || line.startsWith("Binary files "),
  );
  const contentStart = minimumNonNegative(firstHunk, binaryStart);
  const gitHeaderLines =
    contentStart === -1 ? lines : lines.slice(0, contentStart);

  if (binaryStart !== -1 && (firstHunk === -1 || binaryStart < firstHunk)) {
    return {
      gitHeaderLines,
      content: {
        kind: "binary",
        gitBodyLines: lines.slice(binaryStart),
        unsupportedReason: "Binary changes are not reviewable as text.",
      },
    };
  }

  if (firstHunk === -1) {
    return {
      gitHeaderLines,
      content: {
        kind: "metadata-only",
        gitBodyLines: [],
        unsupportedReason: "This file change has no textual diff hunks.",
      },
    };
  }

  try {
    return {
      gitHeaderLines,
      content: {
        kind: "text",
        hunks: parseHunks(lines.slice(firstHunk)),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      gitHeaderLines,
      content: {
        kind: "unsupported",
        gitBodyLines: lines.slice(firstHunk),
        unsupportedReason: `DiffWalk could not parse the textual diff: ${reason}`,
      },
    };
  }
}

function minimumNonNegative(left: number, right: number): number {
  if (left === -1) return right;
  if (right === -1) return left;
  return Math.min(left, right);
}

function parseHunks(lines: readonly string[]): readonly HunkDraft[] {
  const hunks: HunkDraft[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = parseHunkHeader(requiredAt(lines, index, "hunk header"));
    index += 1;
    const diffLines: ParsedLine[] = [];
    let oldLine = header.oldStart;
    let newLine = header.newStart;
    let oldSeen = 0;
    let newSeen = 0;

    while (index < lines.length) {
      const raw = requiredAt(lines, index, "hunk line");
      if (raw.startsWith("@@ ")) break;
      if (raw.startsWith(" ")) {
        diffLines.push({ kind: "context", raw, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
        oldSeen += 1;
        newSeen += 1;
      } else if (raw.startsWith("+")) {
        diffLines.push({ kind: "added", raw, newLine });
        newLine += 1;
        newSeen += 1;
      } else if (raw.startsWith("-")) {
        diffLines.push({ kind: "removed", raw, oldLine });
        oldLine += 1;
        oldSeen += 1;
      } else if (raw === "\\ No newline at end of file") {
        diffLines.push({ kind: "no-newline-marker", raw });
      } else {
        throw new GitSnapshotError(
          `Unexpected unified diff line ${JSON.stringify(raw)}.`,
        );
      }
      index += 1;
    }

    if (oldSeen !== header.oldCount || newSeen !== header.newCount) {
      throw new GitSnapshotError(
        `Hunk ${JSON.stringify(header.raw)} declared ${header.oldCount}/${header.newCount} old/new lines but contained ${oldSeen}/${newSeen}.`,
      );
    }
    hunks.push({ header, lines: diffLines });
  }

  return hunks;
}

function parseHunkHeader(raw: string): HunkHeader {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
  if (!match) {
    throw new GitSnapshotError(
      `Unable to parse unified diff hunk header ${JSON.stringify(raw)}.`,
    );
  }
  const oldStart = requiredAt(match, 1, "hunk old start");
  const oldCount = match[2];
  const newStart = requiredAt(match, 3, "hunk new start");
  const newCount = match[4];
  return {
    raw,
    oldStart: Number.parseInt(oldStart, 10),
    oldCount: oldCount === undefined ? 1 : Number.parseInt(oldCount, 10),
    newStart: Number.parseInt(newStart, 10),
    newCount: newCount === undefined ? 1 : Number.parseInt(newCount, 10),
  };
}

function contentBodyLines(content: ContentDraft): readonly string[] {
  if (content.kind === "text") {
    return content.hunks.flatMap((hunk) => [
      hunk.header.raw,
      ...hunk.lines.map((line) => line.raw),
    ]);
  }
  return content.gitBodyLines;
}

async function buildFileChange(
  git: GitRunner,
  repositoryRoot: string,
  mergeBaseOid: GitObjectId,
  draft: FileChangeDraft,
): Promise<FileChange> {
  const id = hashAs<FileChangeId>("file-change", draft);
  let content: FileChangeContent;
  if (draft.content.kind === "text") {
    const hunks = draft.content.hunks;
    try {
      const oldFile = await readOldFile(
        git,
        repositoryRoot,
        mergeBaseOid,
        draft,
      );
      content = buildTextContent(draft, hunks, oldFile);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      content = {
        kind: "unsupported",
        gitBodyLines: contentBodyLines(draft.content),
        unsupportedReason: `DiffWalk could not reconstruct the frozen file content: ${reason}`,
      };
    }
  } else {
    content = draft.content;
  }
  return {
    id,
    source: draft.source,
    status: draft.status,
    oldPath: draft.oldPath,
    newPath: draft.newPath,
    oldMode: draft.oldMode,
    newMode: draft.newMode,
    gitHeaderLines: draft.gitHeaderLines,
    content,
  };
}

interface OldFileContent {
  readonly lines: readonly string[];
  readonly noTrailingNewline: boolean;
}

async function readOldFile(
  git: GitRunner,
  repositoryRoot: string,
  mergeBaseOid: GitObjectId,
  draft: FileChangeDraft,
): Promise<OldFileContent> {
  if (
    draft.source === "untracked" ||
    draft.status === "added" ||
    draft.oldPath === undefined
  ) {
    return { lines: [], noTrailingNewline: false };
  }
  const output = await runGit(
    git,
    repositoryRoot,
    ["cat-file", "blob", `${mergeBaseOid}:${draft.oldPath}`],
    [0],
    `Unable to read the frozen content of ${JSON.stringify(draft.oldPath)} at the merge base.`,
  );
  return {
    lines: splitLines(output),
    noTrailingNewline: output.length > 0 && !output.endsWith("\n"),
  };
}

/**
 * Rebuilds the whole file as one unified line sequence.
 *
 * Git only emits changed regions plus a small context radius, but a review span
 * may address any line, so the snapshot reconstructs the untouched regions from
 * the frozen old blob. The result is also the old-to-new line number mapping.
 */
function buildTextContent(
  draft: FileChangeDraft,
  hunks: readonly HunkDraft[],
  oldFile: OldFileContent,
): TextChange {
  const lines: DiffLine[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  let oldNoTrailingNewline = false;
  let newNoTrailingNewline = false;
  let markerSeen = false;

  const takeOldLine = (label: string): string => {
    const text = oldFile.lines[oldCursor - 1];
    if (text === undefined) {
      throw new GitSnapshotError(
        `The frozen old file has ${oldFile.lines.length} lines, but ${label} needs line ${oldCursor}.`,
      );
    }
    return text;
  };

  for (const hunk of hunks) {
    const oldBegin =
      hunk.header.oldCount === 0
        ? hunk.header.oldStart + 1
        : hunk.header.oldStart;
    const newBegin =
      hunk.header.newCount === 0
        ? hunk.header.newStart + 1
        : hunk.header.newStart;
    while (oldCursor < oldBegin) {
      lines.push({
        kind: "context",
        oldLine: oldCursor,
        newLine: newCursor,
        text: takeOldLine(`hunk ${JSON.stringify(hunk.header.raw)}`),
      });
      oldCursor += 1;
      newCursor += 1;
    }
    if (newCursor !== newBegin) {
      throw new GitSnapshotError(
        `Hunk ${JSON.stringify(hunk.header.raw)} starts at new line ${newBegin}, but reconstruction reached new line ${newCursor}.`,
      );
    }

    let previousKind: DiffLine["kind"] | undefined;
    for (const line of hunk.lines) {
      if (line.kind === "no-newline-marker") {
        markerSeen = true;
        if (previousKind === "removed" || previousKind === "context") {
          oldNoTrailingNewline = true;
        }
        if (previousKind === "added" || previousKind === "context") {
          newNoTrailingNewline = true;
        }
        continue;
      }
      const text = line.raw.slice(1);
      if (line.kind === "context") {
        lines.push({
          kind: "context",
          oldLine: oldCursor,
          newLine: newCursor,
          text,
        });
        oldCursor += 1;
        newCursor += 1;
      } else if (line.kind === "added") {
        lines.push({ kind: "added", newLine: newCursor, text });
        newCursor += 1;
      } else {
        lines.push({ kind: "removed", oldLine: oldCursor, text });
        oldCursor += 1;
      }
      previousKind = line.kind;
    }
  }

  while (oldCursor <= oldFile.lines.length) {
    lines.push({
      kind: "context",
      oldLine: oldCursor,
      newLine: newCursor,
      text: takeOldLine("the trailing unchanged region"),
    });
    oldCursor += 1;
    newCursor += 1;
  }

  if (!markerSeen) {
    oldNoTrailingNewline = oldFile.noTrailingNewline;
    newNoTrailingNewline = oldFile.noTrailingNewline;
  }

  const oldLineCount = lines.filter(
    (line) => line.oldLine !== undefined,
  ).length;
  const newLineCount = lines.filter(
    (line) => line.newLine !== undefined,
  ).length;
  if (oldLineCount !== oldFile.lines.length) {
    throw new GitSnapshotError(
      `Reconstruction produced ${oldLineCount} old lines, but the frozen old file has ${oldFile.lines.length}.`,
    );
  }

  return {
    kind: "text",
    lines,
    oldLineCount,
    newLineCount,
    oldNoTrailingNewline,
    newNoTrailingNewline,
    suggestedSpans: buildSuggestedSpans(draft, hunks),
  };
}

/** One span per Git hunk, offered to the agent as a starting point it may redraw. */
function buildSuggestedSpans(
  draft: FileChangeDraft,
  hunks: readonly HunkDraft[],
): readonly ReviewSpan[] {
  const path = draft.newPath ?? draft.oldPath;
  if (path === undefined) return [];
  return hunks.map((hunk) => ({
    path,
    ...(hunk.header.oldCount === 0
      ? {}
      : {
          oldStart: hunk.header.oldStart,
          oldEnd: hunk.header.oldStart + hunk.header.oldCount - 1,
        }),
    ...(hunk.header.newCount === 0
      ? {}
      : {
          newStart: hunk.header.newStart,
          newEnd: hunk.header.newStart + hunk.header.newCount - 1,
        }),
  }));
}

function buildCancelledLayerNotices(
  artifacts: StateArtifacts,
  changes: readonly FileChange[],
): readonly SnapshotNotice[] {
  const stagedPaths = collectPaths(artifacts.stagedChanges);
  const unstagedPaths = collectPaths(artifacts.unstagedChanges);
  const netPaths = collectPaths(artifacts.headWorktreeChanges);
  const cancelledPaths = [...stagedPaths]
    .filter((path) => unstagedPaths.has(path) && !netPaths.has(path))
    .sort(compareStringsByUtf8);

  return cancelledPaths.map((filePath) => {
    const fileChange = changes.find(
      (change) => change.oldPath === filePath || change.newPath === filePath,
    );
    const message = `Staged and unstaged changes for ${JSON.stringify(filePath)} cancel in the effective worktree.`;
    return {
      id: hashAs<NoticeId>("snapshot-notice", {
        kind: "cancelled-layer-change",
        fileChangeId: fileChange?.id,
        filePath,
        message,
      }),
      kind: "cancelled-layer-change",
      fileChangeId: fileChange?.id,
      filePath,
      message,
    };
  });
}

function collectPaths(changes: readonly RawFileChange[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.oldPath !== undefined) paths.add(change.oldPath);
    if (change.newPath !== undefined) paths.add(change.newPath);
  }
  return paths;
}

function recordTouchesPaths(
  change: RawFileChange,
  paths: ReadonlySet<string>,
): boolean {
  return (
    (change.oldPath !== undefined && paths.has(change.oldPath)) ||
    (change.newPath !== undefined && paths.has(change.newPath))
  );
}

function sameRepositoryState(
  left: RepositoryState,
  right: RepositoryState,
): boolean {
  return (
    left.headOid === right.headOid &&
    left.stagedFingerprint === right.stagedFingerprint &&
    left.unstagedFingerprint === right.unstagedFingerprint &&
    left.untrackedFingerprint === right.untrackedFingerprint
  );
}

function compareFileChanges(left: FileChange, right: FileChange): number {
  const leftPath = left.newPath ?? left.oldPath ?? "";
  const rightPath = right.newPath ?? right.oldPath ?? "";
  const pathOrder = compareStringsByUtf8(leftPath, rightPath);
  return pathOrder === 0
    ? compareStringsByUtf8(left.source, right.source)
    : pathOrder;
}

function compareStringsByUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function requiredAt<Value>(
  values: readonly Value[],
  index: number,
  label: string,
): Value {
  const value = values[index];
  if (value === undefined) {
    throw new GitSnapshotError(
      `Git output is missing ${label} at index ${index}.`,
    );
  }
  return value;
}

function hashAs<Value extends string>(
  namespace: string,
  value: unknown,
): Value {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(JSON.stringify(value));
  return `${namespace}:${hash.digest("hex")}` as Value;
}

function stripLineTerminator(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
