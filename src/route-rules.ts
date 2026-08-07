import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const DIFFWALK_RULES_SOURCE = `${CONFIG_DIR_NAME}/diffwalk/rules.md`;
export const MAX_DIFFWALK_RULES_BYTES = 16 * 1024;

export interface LoadedDiffWalkRules {
  readonly source: string;
  readonly content: string;
}

/** Load the project-owned review preferences for one route-planning kickoff. */
export async function loadDiffWalkRules(
  cwd: string,
  projectTrusted: boolean,
): Promise<LoadedDiffWalkRules | undefined> {
  if (!projectTrusted) return undefined;

  const rulesPath = join(cwd, CONFIG_DIR_NAME, "diffwalk", "rules.md");
  let raw: Buffer;
  try {
    raw = await readFile(rulesPath);
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw new Error(
      `Cannot read DiffWalk rules from ${rulesPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (raw.byteLength > MAX_DIFFWALK_RULES_BYTES) {
    throw new Error(
      `DiffWalk rules file ${rulesPath} is ${raw.byteLength} bytes; the maximum is ${MAX_DIFFWALK_RULES_BYTES} bytes.`,
    );
  }

  const content = raw.toString("utf8").trim();
  return content.length === 0
    ? undefined
    : { source: DIFFWALK_RULES_SOURCE, content };
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
