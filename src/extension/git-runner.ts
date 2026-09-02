import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../git/runner.ts";

/** Runs Git through pi so the extension never spawns a shell of its own. */
export function createPiGitRunner(
  pi: Pick<ExtensionAPI, "exec">,
  signal?: AbortSignal,
): GitRunner {
  return {
    async run(args, cwd) {
      const result: ExecResult = await pi.exec("git", [...args], {
        cwd,
        signal,
      });
      return result;
    },
  };
}
