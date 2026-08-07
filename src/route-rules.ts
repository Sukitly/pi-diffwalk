import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const DIFFWALK_RULES_SOURCE = `${CONFIG_DIR_NAME}/diffwalk/rules.md`;
export const MAX_DIFFWALK_RULES_BYTES = 16 * 1024;

export interface LoadedDiffWalkRules {
  readonly content: string;
}

export type DiffWalkRulesLoadResult =
  | { readonly status: "loaded"; readonly rules: LoadedDiffWalkRules }
  | { readonly status: "absent" }
  | { readonly status: "ignored-untrusted" }
  | { readonly status: "unavailable"; readonly reason: string };

/** Inspect or load project-owned review preferences without throwing. */
export async function loadDiffWalkRules(
  repositoryRoot: string,
  projectTrusted: boolean,
): Promise<DiffWalkRulesLoadResult> {
  const rulesPath = join(
    repositoryRoot,
    CONFIG_DIR_NAME,
    "diffwalk",
    "rules.md",
  );

  let fileInfo: Stats;
  try {
    fileInfo = await lstat(rulesPath);
  } catch (error: unknown) {
    return isMissingFile(error)
      ? { status: "absent" }
      : {
          status: "unavailable",
          reason: `Cannot inspect DiffWalk rules at ${rulesPath}: ${errorMessage(error)}`,
        };
  }

  if (!projectTrusted) return { status: "ignored-untrusted" };
  if (!fileInfo.isFile()) {
    return {
      status: "unavailable",
      reason: `DiffWalk rules path ${rulesPath} must be a regular file.`,
    };
  }

  let raw: Buffer;
  try {
    raw = await readFile(rulesPath);
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason: `Cannot read DiffWalk rules from ${rulesPath}: ${errorMessage(error)}`,
    };
  }

  if (raw.byteLength > MAX_DIFFWALK_RULES_BYTES) {
    return {
      status: "unavailable",
      reason: `DiffWalk rules file ${rulesPath} is ${raw.byteLength} bytes; the maximum is ${MAX_DIFFWALK_RULES_BYTES} bytes.`,
    };
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
  } catch {
    return {
      status: "unavailable",
      reason: `DiffWalk rules file ${rulesPath} is not valid UTF-8.`,
    };
  }

  return content.length === 0
    ? { status: "absent" }
    : { status: "loaded", rules: { content } };
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
