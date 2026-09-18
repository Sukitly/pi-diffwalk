import { lstat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { ReviewUnit } from "../review/types.ts";

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

/**
 * Throws a message the agent can act on when a unit's routine reference is
 * unusable. The check runs as the unit is appended, so only that unit has to
 * be corrected and resubmitted.
 */
export async function assertRoutineReferences(
  unit: ReviewUnit,
  unitNumber: number,
  repositoryRoot: string,
  exists: RoutineReferenceCheck,
): Promise<void> {
  if (unit.routine === undefined) return;
  const parsed = parseRoutineReference(unit.routine.reference);
  const problem =
    parsed === undefined
      ? `Review unit ${unitNumber} routine.reference ${JSON.stringify(unit.routine.reference)} must be a repository path optionally followed by :start-end line numbers.`
      : (await exists(repositoryRoot, parsed.path))
        ? undefined
        : `Review unit ${unitNumber} routine.reference names ${JSON.stringify(parsed.path)}, which is not a file in the repository.`;
  if (problem === undefined) return;
  throw new RoutineReferenceError(
    `Routine references must name existing code:\n- ${problem}\nCorrect the reference or remove the routine claim, then append the unit again.`,
  );
}
