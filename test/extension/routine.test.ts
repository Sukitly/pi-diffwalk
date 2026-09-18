import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRoutineReferences,
  parseRoutineReference,
  RoutineReferenceError,
  routineReferenceExists,
} from "../../src/extension/routine.ts";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";

test("parses a path with optional line range and rejects malformed ranges", () => {
  assert.deepEqual(parseRoutineReference("src/a.ts"), { path: "src/a.ts" });
  assert.deepEqual(parseRoutineReference(" src/a.ts:12 "), {
    path: "src/a.ts",
    startLine: 12,
  });
  assert.deepEqual(parseRoutineReference("src/a.ts:12-40"), {
    path: "src/a.ts",
    startLine: 12,
    endLine: 40,
  });
  assert.deepEqual(parseRoutineReference("c:/odd path/x.ts:3"), {
    path: "c:/odd path/x.ts",
    startLine: 3,
  });
  assert.equal(parseRoutineReference(""), undefined);
  assert.equal(parseRoutineReference(":3"), undefined);
  assert.equal(parseRoutineReference("src/a.ts:0"), undefined);
  assert.equal(parseRoutineReference("src/a.ts:9-3"), undefined);
});

test("routineReferenceExists accepts regular files inside the repository only", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "pi-diffwalk-routine-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src", "a.ts"), "x\n");
  await symlink(join(repository, "src", "a.ts"), join(repository, "link.ts"));

  assert.equal(await routineReferenceExists(repository, "src/a.ts"), true);
  assert.equal(await routineReferenceExists(repository, "src"), false);
  assert.equal(await routineReferenceExists(repository, "link.ts"), false);
  assert.equal(await routineReferenceExists(repository, "missing.ts"), false);
  assert.equal(await routineReferenceExists(repository, "../etc"), false);
  assert.equal(
    await routineReferenceExists(repository, join(repository, "src", "a.ts")),
    false,
  );
  assert.equal(await routineReferenceExists(repository, ""), false);
});

test("assertRoutineReferences reports every unusable reference at once", async () => {
  const snapshot = makeSnapshot("snapshot-routine", [
    { path: "src/a.ts", lines: [" head", "+a", " tail"] },
    { path: "src/b.ts", lines: [" head", "+b", " tail"] },
    { path: "src/c.ts", lines: [" head", "+c", " tail"] },
  ]);
  const unit = (
    path: string,
    routine?: { reference: string; reason: string },
  ) => ({
    title: path,
    whyHere: "Next.",
    context: "ctx",
    changeSummary: "Adds a line.",
    reviewFocus: [{ question: "Fine?" }],
    spans: [span(path, { new: [2, 2] })],
    ...(routine === undefined ? {} : { routine }),
  });
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      unit("src/a.ts"),
      unit("src/b.ts", { reference: "src/exists.ts:1-2", reason: "Same." }),
      unit("src/c.ts", { reference: "src/missing.ts", reason: "Same." }),
    ],
    skippedSpans: [],
  });
  const exists = async (_root: string, path: string) =>
    path === "src/exists.ts";

  await assertRoutineReferences(
    { ...route, units: route.units.slice(0, 2) } as typeof route,
    "/repo",
    exists,
  );
  await assert.rejects(
    assertRoutineReferences(route, "/repo", exists),
    (error: unknown) => {
      assert.ok(error instanceof RoutineReferenceError);
      assert.match(
        error.message,
        /Review unit 3 routine\.reference names "src\/missing\.ts"/,
      );
      assert.doesNotMatch(error.message, /Review unit 2/);
      assert.match(error.message, /remove the routine claim/);
      return true;
    },
  );
});
