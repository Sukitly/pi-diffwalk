import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function parseVersion(version: string): number[] {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/.exec(
      version,
    );
  if (!match)
    throw new Error(`Invalid version ${version}; use X.Y.Z or X.Y.Z-alpha.N.`);
  const numbers = match.slice(1, 4).map(Number);
  if (match[4] !== undefined) numbers.push(Number(match[4]));
  if (!numbers.every(Number.isSafeInteger))
    throw new Error("Version numbers exceed the safe integer range.");
  return numbers;
}

export function releaseTag(
  current: string,
  target: string,
): "alpha" | "latest" {
  const before = parseVersion(current);
  const after = parseVersion(target);
  let comparison = 0;
  for (let i = 0; i < 4; i++) {
    const a = after[i] ?? Infinity;
    const b = before[i] ?? Infinity;
    if (a !== b) {
      comparison = a > b ? 1 : -1;
      break;
    }
  }
  if (comparison !== 1)
    throw new Error(`Version ${target} must be newer than ${current}.`);
  return after.length === 4 ? "alpha" : "latest";
}

export function parseArguments(args: string[]) {
  const [version, ...flags] = args;
  if (
    !version ||
    flags.some((flag) => !["--dry-run", "--yes", "-y"].includes(flag))
  ) {
    throw new Error(
      "Usage: npm run release -- <X.Y.Z[-alpha.N]> [--dry-run] [--yes]",
    );
  }
  parseVersion(version);
  return {
    version,
    dryRun: flags.includes("--dry-run"),
    yes: flags.includes("--yes") || flags.includes("-y"),
  };
}

type Result = { status: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[]) => Result;

const execute: Runner = (command, args) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    stdio: command === "npm" && args[0] === "publish" ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export async function release(
  args: string[],
  manifest: { name: string; version: string },
  runner: Runner,
  confirm: (message: string) => Promise<boolean>,
): Promise<void> {
  const options = parseArguments(args);
  const distTag = releaseTag(manifest.version, options.version);
  const tag = `v${options.version}`;
  const run = (command: string, commandArgs: string[]) => {
    const result = runner(command, commandArgs);
    if (result.status !== 0)
      throw new Error(
        `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout.trim();
  };
  const npm = (commandArgs: string[]) =>
    run("npm", [...commandArgs, "--ignore-scripts", `--registry=${REGISTRY}`]);
  const clean = () => {
    if (run("git", ["status", "--porcelain", "--untracked-files=all"]))
      throw new Error(
        "Working tree must be clean. Commit or stash changes before releasing.",
      );
  };
  const branch = run("git", ["branch", "--show-current"]);
  if (branch !== "main" && branch !== "master")
    throw new Error(
      "Release from main or master, not a feature branch or detached HEAD.",
    );
  clean();
  const head = run("git", ["rev-parse", "HEAD"]);
  const remoteHead = run("git", [
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${branch}`,
  ]).split(/\s+/)[0];
  if (head !== remoteHead)
    throw new Error(
      `HEAD must match origin/${branch}. Synchronize the branch first.`,
    );
  if (
    run("git", ["tag", "--list", tag]) ||
    run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])
  )
    throw new Error(`Tag ${tag} already exists.`);
  npm(["whoami"]);
  const registry = runner("npm", [
    "view",
    manifest.name,
    "versions",
    "--json",
    `--registry=${REGISTRY}`,
    "--ignore-scripts",
  ]);
  let versions: unknown;
  if (registry.status !== 0) {
    let errorCode: unknown;
    try {
      errorCode = (
        JSON.parse(registry.stdout) as { error?: { code?: unknown } }
      ).error?.code;
    } catch {
      throw new Error(
        `Cannot read npm versions: ${registry.stderr || registry.stdout}`,
      );
    }
    if (errorCode !== "E404")
      throw new Error(
        `Cannot read npm versions: ${registry.stderr || registry.stdout}`,
      );
    versions = [];
  } else {
    versions = JSON.parse(registry.stdout) as unknown;
  }
  const published = typeof versions === "string" ? [versions] : versions;
  if (
    !Array.isArray(published) ||
    !published.every((v) => typeof v === "string")
  )
    throw new Error("Unexpected npm versions response.");
  if (published.includes(options.version))
    throw new Error(
      `${manifest.name}@${options.version} is already published. Do not overwrite an existing release.`,
    );
  for (const version of published) releaseTag(version, options.version);
  npm(["run", "check"]);
  npm(["test"]);
  const packed = JSON.parse(npm(["pack", "--dry-run", "--json"])) as {
    files: { path: string }[];
  }[];
  const files = packed[0]?.files.map((file) => file.path) ?? [];
  if (
    !["src/index.ts", "README.md", "LICENSE", "package.json"].every((path) =>
      files.includes(path),
    ) ||
    files.some(
      (path) =>
        !path.startsWith("src/") &&
        !["README.md", "LICENSE", "package.json"].includes(path),
    )
  )
    throw new Error(
      "Unexpected npm package contents. Inspect npm pack --dry-run --ignore-scripts.",
    );
  clean();
  run("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/${branch}`]);
  if (options.dryRun) {
    console.log(
      `Preflight passed for ${tag} (${distTag}). No version, commit, tag, push, or publication created.`,
    );
    return;
  }
  if (
    !options.yes &&
    !(await confirm(
      `Release ${manifest.name}@${options.version} to npm ${distTag}, commit, tag, and push? [y/N] `,
    ))
  )
    throw new Error("Release cancelled.");
  clean();
  if (run("git", ["rev-parse", "HEAD"]) !== head)
    throw new Error("HEAD changed during preflight. Restart the release.");
  try {
    npm(["version", options.version, "--no-git-tag-version"]);
    run("git", ["status", "--short"]);
    run("git", ["add", "--", "package.json", "package-lock.json"]);
    run("git", ["status", "--short"]);
    run("git", ["diff", "--cached", "--check"]);
    run("git", ["commit", "-m", `Release ${tag}`]);
    run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
    run("git", [
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `refs/tags/${tag}`,
    ]);
  } catch (error) {
    throw new Error(
      `Release preparation or push failed; npm publication was not attempted. Inspect git status, the release commit, and ${tag}; finish the commit/tag and push both before publishing. Do not blindly rerun the release.`,
      { cause: error },
    );
  }
  try {
    npm(["publish", "--access", "public", "--tag", distTag]);
  } catch (error) {
    throw new Error(
      `${tag} was pushed, but publication failed. Check npm view ${manifest.name}@${options.version} version before retrying. If absent, retry npm publish --ignore-scripts --access public --tag ${distTag} --registry=${REGISTRY} from the release commit. Do not bump again.`,
      { cause: error },
    );
  }
  try {
    const tags = JSON.parse(
      npm(["view", manifest.name, "dist-tags", "--json"]),
    ) as Record<string, unknown>;
    if (tags[distTag] !== options.version)
      throw new Error(
        `Unexpected ${distTag} version: ${String(tags[distTag])}.`,
      );
  } catch (error) {
    throw new Error(
      `Publication completed but registry verification failed. Verify ${manifest.name}@${options.version} and its ${distTag} tag manually; do not bump or republish.`,
      { cause: error },
    );
  }
  console.log(
    `Published ${manifest.name}@${options.version} under ${distTag}; pushed ${tag}.`,
  );
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Confirmation requires a TTY. Use --yes for non-interactive releases.",
    );
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return /^y(?:es)?$/i.test((await input.question(message)).trim());
  } finally {
    input.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    console.log(
      "Usage: npm run release -- <X.Y.Z[-alpha.N]> [--dry-run] [--yes]",
    );
  } else {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    release(process.argv.slice(2), manifest, execute, confirm).catch(
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
