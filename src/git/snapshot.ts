import { hashAs } from "../review/ids.ts";
import type {
  FileChange,
  NoticeId,
  RepositoryState,
  ReviewSnapshot,
  SnapshotId,
  SnapshotNotice,
  StateFingerprint,
} from "../review/types.ts";
import { buildFileChange } from "./content.ts";
import { GitSnapshotError, ReviewSnapshotDriftError } from "./errors.ts";
import {
  buildTrackedDrafts,
  buildUntrackedDraft,
  compareStringsByUtf8,
  parseRawDiff,
  type RawFileChange,
  splitNul,
  splitPatchBlocks,
  type UntrackedFile,
} from "./patch.ts";
import {
  DIFF_CONFIG,
  diffArgs,
  type GitRunner,
  PATCH_OPTIONS,
  RAW_OPTIONS,
  resolveCommit,
  resolveMergeBase,
  resolveRepositoryRoot,
  resolveSourceBranch,
  runGit,
} from "./runner.ts";

interface RepositoryStateArtifacts {
  readonly state: RepositoryState;
  readonly untrackedFiles: readonly UntrackedFile[];
}

interface StateArtifacts extends RepositoryStateArtifacts {
  readonly stagedChanges: readonly RawFileChange[];
  readonly unstagedChanges: readonly RawFileChange[];
  readonly headWorktreeChanges: readonly RawFileChange[];
}

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
        type: "cancelled-layer-change",
        fileChangeId: fileChange?.id,
        filePath,
        message,
      }),
      type: "cancelled-layer-change",
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
