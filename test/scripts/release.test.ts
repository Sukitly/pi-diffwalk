import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArguments,
  type Runner,
  release,
  releaseTag,
} from "../../scripts/release.ts";

const manifest = { name: "pi-diffwalk", version: "0.0.0" };
function harness(
  overrides: Record<string, Partial<ReturnType<Runner>> | undefined> = {},
) {
  const calls: string[] = [];
  const runner: Runner = (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    calls.push(key);
    let stdout = "";
    if (key === "git branch --show-current") stdout = "main";
    if (key === "git rev-parse HEAD") stdout = "abc";
    if (key.includes("ls-remote --exit-code")) stdout = "abc\trefs/heads/main";
    if (key.includes(" versions ")) stdout = "[]";
    if (key.includes("npm pack"))
      stdout = JSON.stringify([
        {
          files: ["src/index.ts", "README.md", "LICENSE", "package.json"].map(
            (path) => ({ path }),
          ),
        },
      ]);
    if (key.includes("dist-tags")) stdout = '{"alpha":"0.1.0-alpha.1"}';
    const override = Object.entries(overrides).find(([prefix]) =>
      key.startsWith(prefix),
    )?.[1];
    return { status: 0, stdout, stderr: "", ...override };
  };
  return { calls, runner };
}

test("release versions support alpha increments and stable promotion", () => {
  assert.equal(releaseTag("0.0.0", "0.1.0-alpha.1"), "alpha");
  assert.equal(releaseTag("0.1.0-alpha.1", "0.1.0-alpha.2"), "alpha");
  assert.equal(releaseTag("0.1.0-alpha.2", "0.1.0"), "latest");
  for (const version of ["0.1.0-alpha.1", "0.0.9", "0.1.0-alpha.0"])
    assert.throws(() => releaseTag("0.1.0-alpha.1", version));
  for (const version of [
    "01.0.0",
    "patch",
    "1.0.0-beta.1",
    "1.0.0;echo",
    "1.0.0-alpha.01",
  ])
    assert.throws(() => parseArguments([version]));
  assert.throws(() => parseArguments(["1.0.0", "--force"]));
});

test("dry run checks packaging without writes, publishing, or confirmation", async () => {
  const { calls, runner } = harness();
  await release(["0.1.0-alpha.1", "--dry-run"], manifest, runner, async () => {
    throw new Error("Unexpected confirmation");
  });
  assert.ok(calls.some((call) => call.startsWith("npm pack --dry-run")));
  assert.ok(
    !calls.some((call) =>
      /^(npm (version|publish)|git (add|commit|tag -a))/.test(call),
    ),
  );
  assert.ok(
    calls
      .filter((call) => call.startsWith("git push"))
      .every((call) => call.includes("--dry-run")),
  );
});

test("first release accepts npm E404 and publishes alpha with atomic exact-ref push", async () => {
  const { calls, runner } = harness({
    "npm view pi-diffwalk versions": {
      status: 1,
      stdout: '{"error":{"code":"E404"}}',
    },
  });
  await release(
    ["0.1.0-alpha.1", "--yes"],
    manifest,
    runner,
    async () => false,
  );
  const push = calls.indexOf(
    "git push --atomic origin HEAD:refs/heads/main refs/tags/v0.1.0-alpha.1",
  );
  assert.ok(push >= 0);
  assert.ok(
    calls.findIndex((call) =>
      call.startsWith("npm publish --access public --tag alpha"),
    ) > push,
  );
  assert.ok(
    calls
      .filter((call) => call.startsWith("npm "))
      .every((call) => call.includes("--ignore-scripts")),
  );
});

test("preflight rejects unsafe state and registry failures before mutation", async () => {
  for (const overrides of [
    { "git branch": { stdout: "feature" } },
    { "git status": { stdout: " M README.md" } },
    { "git ls-remote --exit-code": { stdout: "other\trefs/heads/main" } },
    { "git tag --list": { stdout: "v0.1.0-alpha.1" } },
    { "npm whoami": { status: 1, stderr: "Not authenticated" } },
    {
      "npm view pi-diffwalk versions": {
        status: 1,
        stdout: '{"error":{"code":"E401"}}',
      },
    },
    {
      "npm view pi-diffwalk versions": {
        status: 1,
        stdout: "",
        stderr: "Network failed",
      },
    },
    { "npm view pi-diffwalk versions": { stdout: '["0.1.0-alpha.1"]' } },
    { "npm view pi-diffwalk versions": { stdout: '["0.2.0"]' } },
    { "npm run check": { status: 1, stderr: "Typecheck failed" } },
    { "npm test": { status: 1, stderr: "Tests failed" } },
    { "npm pack": { stdout: '[{"files":[{"path":".env"}]}]' } },
  ]) {
    const { calls, runner } = harness(overrides);
    await assert.rejects(
      release(["0.1.0-alpha.1", "--yes"], manifest, runner, async () => true),
    );
    assert.ok(
      !calls.some(
        (call) =>
          call.startsWith("npm version") || call.startsWith("npm publish"),
      ),
    );
  }
});

test("stable promotion explicitly publishes to latest", async () => {
  const { calls, runner } = harness({
    "npm view pi-diffwalk versions": { stdout: '["0.1.0-alpha.1"]' },
    "npm view pi-diffwalk dist-tags": { stdout: '{"latest":"0.1.0"}' },
  });
  await release(
    ["0.1.0", "--yes"],
    { ...manifest, version: "0.1.0-alpha.1" },
    runner,
    async () => false,
  );
  assert.ok(
    calls.some((call) =>
      call.startsWith("npm publish --access public --tag latest"),
    ),
  );
});

test("verification failure warns against repeating publication", async () => {
  const { runner } = harness({
    "npm view pi-diffwalk dist-tags": { stdout: "{}" },
  });
  await assert.rejects(
    release(["0.1.0-alpha.1", "--yes"], manifest, runner, async () => false),
    /do not bump or republish/,
  );
});

test("cancellation does not change the version", async () => {
  const { calls, runner } = harness();
  await assert.rejects(
    release(["0.1.0-alpha.1"], manifest, runner, async () => false),
    /cancelled/,
  );
  assert.ok(!calls.some((call) => call.startsWith("npm version")));
});

test("push failure prevents publishing; publication failure gives recovery instructions", async () => {
  const pushFailure = harness({
    "git push --atomic": { status: 1, stderr: "Rejected" },
  });
  await assert.rejects(
    release(
      ["0.1.0-alpha.1", "--yes"],
      manifest,
      pushFailure.runner,
      async () => true,
    ),
    /npm publication was not attempted/,
  );
  assert.ok(!pushFailure.calls.some((call) => call.startsWith("npm publish")));
  const publishFailure = harness({
    "npm publish": { status: 1, stderr: "OTP required" },
  });
  await assert.rejects(
    release(
      ["0.1.0-alpha.1", "--yes"],
      manifest,
      publishFailure.runner,
      async () => true,
    ),
    /--tag alpha.*Do not bump again/,
  );
});
