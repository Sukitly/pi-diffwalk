import type { PathExclusionFacts } from "../review/exclusion.ts";
import { GitSnapshotError } from "./errors.ts";
import { type GitRunner, runGit } from "./runner.ts";

/**
 * Path facts for mechanical exclusion, answered by Git so that pattern syntax
 * and attribute lookup match what users already know from `.gitignore` and
 * `.gitattributes`.
 */

export const GENERATED_ATTRIBUTE = "linguist-generated";

/** Keeps every invocation well inside argument-length limits. */
const PATH_BATCH_SIZE = 200;

export interface PathExclusionSources {
  /** Absolute path of the DiffWalk exclude file, in gitignore syntax. */
  readonly excludeFile?: string;
  /** Whether to honor `linguist-generated` from Git attributes. */
  readonly generatedAttribute: boolean;
}

export async function resolvePathExclusionFacts(
  git: GitRunner,
  repositoryRoot: string,
  paths: readonly string[],
  sources: PathExclusionSources,
): Promise<PathExclusionFacts> {
  const unique = [...new Set(paths)];
  const excludedPaths = new Map<string, string>();
  const generatedPaths = new Set<string>();
  for (let start = 0; start < unique.length; start += PATH_BATCH_SIZE) {
    const batch = unique.slice(start, start + PATH_BATCH_SIZE);
    if (sources.excludeFile !== undefined) {
      for (const [path, pattern] of await matchExcludeFile(
        git,
        repositoryRoot,
        batch,
        sources.excludeFile,
      )) {
        excludedPaths.set(path, pattern);
      }
    }
    if (sources.generatedAttribute) {
      for (const path of await matchGeneratedAttribute(
        git,
        repositoryRoot,
        batch,
      )) {
        generatedPaths.add(path);
      }
    }
  }
  return { excludedPaths, generatedPaths };
}

/**
 * `check-ignore` also consults the repository's own ignore files. Only a
 * match that came from the DiffWalk exclude file counts, and a negated
 * pattern is a decision to keep the path.
 *
 * `-z` requires `--stdin`, which the runner cannot provide, so the verbose
 * line format is parsed instead. `--non-matching` makes Git print exactly
 * one line per input path in input order, and `core.quotePath=true` keeps
 * every path on one line, so each line is matched to its path by position
 * and the quoted path column is never interpreted.
 */
async function matchExcludeFile(
  git: GitRunner,
  repositoryRoot: string,
  paths: readonly string[],
  excludeFile: string,
): Promise<ReadonlyMap<string, string>> {
  const args = [
    "-c",
    `core.excludesFile=${excludeFile}`,
    "-c",
    "core.quotePath=true",
    "check-ignore",
    "--no-index",
    "--verbose",
    "--non-matching",
    "--",
    ...paths,
  ];
  const output = await runGit(
    git,
    repositoryRoot,
    args,
    [0, 1],
    "Unable to evaluate the DiffWalk exclude file.",
  );
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== paths.length) {
    throw new GitSnapshotError(
      `Git returned ${lines.length} check-ignore lines for ${paths.length} paths.`,
      args,
    );
  }
  const sourcePrefix = `${excludeFile}:`;
  const matches = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const path = paths[index];
    if (path === undefined || !line.startsWith(sourcePrefix)) continue;
    const afterSource = line.slice(sourcePrefix.length);
    const patternStart = afterSource.indexOf(":");
    const patternEnd = afterSource.indexOf("\t");
    if (patternStart === -1 || patternEnd === -1 || patternEnd < patternStart) {
      throw new GitSnapshotError(
        "Git returned an unexpected check-ignore line layout.",
        args,
      );
    }
    const pattern = afterSource.slice(patternStart + 1, patternEnd);
    if (pattern.startsWith("!")) continue;
    matches.set(path, pattern);
  }
  return matches;
}

async function matchGeneratedAttribute(
  git: GitRunner,
  repositoryRoot: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  const args = ["check-attr", "-z", GENERATED_ATTRIBUTE, "--", ...paths];
  const output = await runGit(
    git,
    repositoryRoot,
    args,
    [0],
    `Unable to read the ${GENERATED_ATTRIBUTE} attribute.`,
  );
  const fields = splitNul(output);
  if (fields.length % 3 !== 0) {
    throw new GitSnapshotError(
      "Git returned an unexpected check-attr record layout.",
      args,
    );
  }
  const generated = new Set<string>();
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index] ?? "";
    const value = fields[index + 2] ?? "";
    if (value === "set" || value === "true") generated.add(path);
  }
  return generated;
}

function splitNul(output: string): readonly string[] {
  if (output.length === 0) return [];
  const fields = output.split("\u0000");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}
