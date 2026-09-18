import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PathExclusionSources } from "../git/exclusion.ts";
import { GENERATED_ATTRIBUTE } from "../git/exclusion.ts";
import type { ReviewSnapshot } from "../review/types.ts";

export const DIFFWALK_EXCLUDE_SOURCE = `${CONFIG_DIR_NAME}/diffwalk/exclude`;
const GIT_ATTRIBUTES_FILE = ".gitattributes";

export type DiffWalkExcludeScope = "global" | "project";

export type DiffWalkExcludeFileResult =
  | {
      readonly status: "found";
      readonly scope: DiffWalkExcludeScope;
      readonly path: string;
    }
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly reason: string };

export async function locateGlobalDiffWalkExcludeFile(
  agentDir = getAgentDir(),
): Promise<DiffWalkExcludeFileResult> {
  return locateExcludeFile(join(agentDir, "diffwalk", "exclude"), "global");
}

export async function locateProjectDiffWalkExcludeFile(
  repositoryRoot: string,
): Promise<DiffWalkExcludeFileResult> {
  return locateExcludeFile(
    join(repositoryRoot, CONFIG_DIR_NAME, "diffwalk", "exclude"),
    "project",
  );
}

/**
 * Git reads the exclude file; the extension only confirms it is a regular
 * file so that a directory or dangling link produces a warning instead of a
 * silent no-match.
 */
async function locateExcludeFile(
  path: string,
  scope: DiffWalkExcludeScope,
): Promise<DiffWalkExcludeFileResult> {
  let fileInfo: Stats;
  try {
    fileInfo = await lstat(path);
  } catch (error: unknown) {
    return isMissingFile(error)
      ? { status: "absent" }
      : {
          status: "unavailable",
          reason: `Cannot inspect DiffWalk exclude file at ${path}: ${errorMessage(error)}`,
        };
  }
  if (!fileInfo.isFile()) {
    return {
      status: "unavailable",
      reason: `DiffWalk exclude path ${path} must be a regular file.`,
    };
  }
  return { status: "found", scope, path };
}

export interface ExclusionSourceDecision {
  readonly sources: PathExclusionSources;
  /** Which exclude file `sources.excludeFile` came from, when one was chosen. */
  readonly excludeScope?: DiffWalkExcludeScope;
  /** Warnings the user should see about sources that were ignored. */
  readonly warnings: readonly string[];
}

export interface ExclusionSourceLocators {
  readonly locateGlobalExcludeFile: () => Promise<DiffWalkExcludeFileResult>;
  readonly locateProjectExcludeFile: (
    repositoryRoot: string,
  ) => Promise<DiffWalkExcludeFileResult>;
}

/**
 * Exclusion hides changed lines from the reviewer, so every project-owned
 * source obeys the same rule as project review rules: it is ignored when the
 * project is not trusted or when the source is itself part of the change.
 * A usable project exclude file replaces the global file completely.
 */
export async function decideExclusionSources(
  snapshot: ReviewSnapshot,
  projectTrusted: boolean,
  locators: ExclusionSourceLocators,
): Promise<ExclusionSourceDecision> {
  const warnings: string[] = [];
  const changedPaths = new Set<string>();
  for (const change of snapshot.changes) {
    if (change.oldPath !== undefined) changedPaths.add(change.oldPath);
    if (change.newPath !== undefined) changedPaths.add(change.newPath);
  }

  let generatedAttribute = false;
  const attributesChanged = [...changedPaths].some(
    (path) => basename(path) === GIT_ATTRIBUTES_FILE,
  );
  if (!projectTrusted) {
    warnings.push(
      `Ignored ${GENERATED_ATTRIBUTE} attributes because the project is not trusted.`,
    );
  } else if (attributesChanged) {
    warnings.push(
      `Ignored ${GENERATED_ATTRIBUTE} attributes because a ${GIT_ATTRIBUTES_FILE} file is part of snapshot ${snapshot.id}. Attributes cannot shape the review of their own changes.`,
    );
  } else {
    generatedAttribute = true;
  }

  const excludeFile = await chooseExcludeFile(
    snapshot,
    projectTrusted,
    changedPaths,
    locators,
    warnings,
  );

  return {
    sources: {
      ...(excludeFile === undefined ? {} : { excludeFile: excludeFile.path }),
      generatedAttribute,
    },
    ...(excludeFile === undefined ? {} : { excludeScope: excludeFile.scope }),
    warnings,
  };
}

async function chooseExcludeFile(
  snapshot: ReviewSnapshot,
  projectTrusted: boolean,
  changedPaths: ReadonlySet<string>,
  locators: ExclusionSourceLocators,
  warnings: string[],
): Promise<
  { readonly path: string; readonly scope: DiffWalkExcludeScope } | undefined
> {
  if (changedPaths.has(DIFFWALK_EXCLUDE_SOURCE)) {
    warnings.push(
      `Ignored ${DIFFWALK_EXCLUDE_SOURCE} because it is part of snapshot ${snapshot.id}. Project exclusions cannot shape the review of their own changes.`,
    );
  } else if (!projectTrusted) {
    const project = await locators.locateProjectExcludeFile(
      snapshot.repositoryRoot,
    );
    if (project.status !== "absent") {
      warnings.push(
        `Ignored ${DIFFWALK_EXCLUDE_SOURCE} because the project is not trusted.`,
      );
    }
  } else {
    const project = await locators.locateProjectExcludeFile(
      snapshot.repositoryRoot,
    );
    if (project.status === "found") {
      return { path: project.path, scope: "project" };
    }
    if (project.status === "unavailable") {
      warnings.push(`${project.reason} Continuing without it.`);
    }
  }

  const global = await locators.locateGlobalExcludeFile();
  if (global.status === "found") return { path: global.path, scope: "global" };
  if (global.status === "unavailable") {
    warnings.push(`${global.reason} Continuing without it.`);
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
