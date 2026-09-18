import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { ReviewRoute } from "../review/types.ts";

/**
 * A routine claim names existing code the unit mirrors. The reference is
 * the one part of the claim code can check without judgment: the path must
 * be a regular file inside the repository. Line numbers are accepted and not
 * verified; the reviewer sees them when deciding whether to expand.
 */

export interface ParsedRoutineReference {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

const REFERENCE_PATTERN = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/s;

export function parseRoutineReference(
  reference: string,
): ParsedRoutineReference | undefined {
  const match = REFERENCE_PATTERN.exec(reference.trim());
  const path = match?.[1];
  if (path === undefined || path.length === 0) return undefined;
  const startLine = match?.[2] === undefined ? undefined : Number(match[2]);
  const endLine = match?.[3] === undefined ? undefined : Number(match[3]);
  if (startLine !== undefined && startLine < 1) return undefined;
  if (
    endLine !== undefined &&
    (startLine === undefined || endLine < startLine)
  ) {
    return undefined;
  }
  return {
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

export type RoutineReferenceCheck = (
  repositoryRoot: string,
  path: string,
) => Promise<boolean>;

/** Regular file inside the repository root; never follows a path outside it. */
export const routineReferenceExists: RoutineReferenceCheck = async (
  repositoryRoot,
  path,
) => {
  if (isAbsolute(path)) return false;
  const resolved = normalize(join(repositoryRoot, path));
  const relativePath = relative(repositoryRoot, resolved);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return false;
  try {
    return (await lstat(resolved)).isFile();
  } catch {
    return false;
  }
};

export class RoutineReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineReferenceError";
  }
}

/** Throws a message the agent can act on when any routine reference is unusable. */
export async function assertRoutineReferences(
  route: ReviewRoute,
  repositoryRoot: string,
  exists: RoutineReferenceCheck,
): Promise<void> {
  const problems: string[] = [];
  for (const [index, unit] of route.units.entries()) {
    if (unit.routine === undefined) continue;
    const parsed = parseRoutineReference(unit.routine.reference);
    if (parsed === undefined) {
      problems.push(
        `Review unit ${index + 1} routine.reference ${JSON.stringify(unit.routine.reference)} must be a repository path optionally followed by :start-end line numbers.`,
      );
      continue;
    }
    if (!(await exists(repositoryRoot, parsed.path))) {
      problems.push(
        `Review unit ${index + 1} routine.reference names ${JSON.stringify(parsed.path)}, which is not a file in the repository.`,
      );
    }
  }
  if (problems.length > 0) {
    throw new RoutineReferenceError(
      `Routine references must name existing code:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nCorrect the reference or remove the routine claim, then call the tool again.`,
    );
  }
}
