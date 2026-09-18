import assert from "node:assert/strict";
import test from "node:test";
import {
  computeExclusions,
  describeExclusion,
  EMPTY_PATH_EXCLUSION_FACTS,
  exclusionPath,
  whitespaceOnlyLines,
} from "../../src/review/exclusion.ts";
import { changedLineKey, textContent } from "../../src/review/span.ts";
import type { FileChange, ReviewSnapshot } from "../../src/review/types.ts";
import { makeFileChange, makeSnapshot } from "../support/domain-fixtures.ts";

function changeAt(snapshot: ReviewSnapshot, path: string): FileChange {
  const change = snapshot.changes.find(
    (candidate) => exclusionPath(candidate) === path,
  );
  assert.ok(change, `No change for ${path}`);
  return change;
}

function markedLines(
  snapshot: ReviewSnapshot,
  path: string,
  marks: ReadonlyMap<string, unknown>,
): readonly string[] {
  const change = changeAt(snapshot, path);
  const content = textContent(change);
  assert.ok(content);
  const result: string[] = [];
  for (const line of content.lines) {
    if (line.type === "context") continue;
    const side = line.type === "added" ? "new" : "old";
    const number = side === "new" ? line.newLine : line.oldLine;
    assert.ok(number !== undefined);
    const key = changedLineKey({ fileChangeId: change.id, side, line: number });
    if (marks.has(key)) result.push(`${side}:${number}`);
  }
  return result;
}

test("whitespace-only: trailing and interior spacing changes match line by line", () => {
  const change = makeFileChange({
    path: "src/a.ts",
    lines: [
      " head",
      "-const  x = 1;   ",
      "-call(a,b)",
      "+const x = 1;",
      "+call(a, b)",
      " tail",
    ],
  });
  const content = textContent(change);
  assert.ok(content);
  assert.deepEqual(
    whitespaceOnlyLines(change, content.lines).map((line) => line.line),
    [2, 3, 2, 3],
  );
});

test("whitespace-only: added or removed blank lines match", () => {
  const change = makeFileChange({
    path: "src/a.ts",
    lines: [" head", "+", "+   ", " tail", "-", " end"],
  });
  const content = textContent(change);
  assert.ok(content);
  assert.equal(whitespaceOnlyLines(change, content.lines).length, 3);
});

test("whitespace-only: leading whitespace must match exactly", () => {
  const change = makeFileChange({
    path: "src/a.py",
    lines: [" if x:", "-    return 1", "+        return 1", " tail"],
  });
  const content = textContent(change);
  assert.ok(content);
  assert.deepEqual(whitespaceOnlyLines(change, content.lines), []);
});

test("whitespace-only: a run with any content change is kept", () => {
  const change = makeFileChange({
    path: "src/a.ts",
    lines: [
      " head",
      "-const x = 1;",
      "-y = 2",
      "+const x = 1;",
      "+y = 3",
      " tail",
    ],
  });
  const content = textContent(change);
  assert.ok(content);
  assert.deepEqual(whitespaceOnlyLines(change, content.lines), []);
});

test("whitespace-only: a token split across lines is a content change", () => {
  const change = makeFileChange({
    path: "src/a.ts",
    lines: [" head", "-foo bar", "+foo", "+bar", " tail"],
  });
  const content = textContent(change);
  assert.ok(content);
  assert.deepEqual(whitespaceOnlyLines(change, content.lines), []);
});

test("whitespace-only: runs are judged independently within one file", () => {
  const snapshot = makeSnapshot("snapshot-runs", [
    {
      path: "src/a.ts",
      lines: [
        " head",
        "-const  x = 1;",
        "+const x = 1;",
        " middle",
        "-return a",
        "+return b",
        " tail",
      ],
    },
  ]);
  const marks = computeExclusions(snapshot, EMPTY_PATH_EXCLUSION_FACTS);
  assert.deepEqual(markedLines(snapshot, "src/a.ts", marks), [
    "old:2",
    "new:2",
  ]);
  const mark = marks.get(
    changedLineKey({
      fileChangeId: changeAt(snapshot, "src/a.ts").id,
      side: "new",
      line: 2,
    }),
  );
  assert.deepEqual(mark, { reason: "whitespace-only" });
});

test("excluded-path marks every changed line in the file with the pattern", () => {
  const snapshot = makeSnapshot("snapshot-path", [
    {
      path: "package-lock.json",
      lines: [" {", '-  "a": 1', '+  "a": 2', '+  "b": 3', " }"],
    },
    { path: "src/a.ts", lines: [" head", "+real change", " tail"] },
  ]);
  const marks = computeExclusions(snapshot, {
    excludedPaths: new Map([["package-lock.json", "*-lock.json"]]),
    generatedPaths: new Set(),
  });
  assert.deepEqual(markedLines(snapshot, "package-lock.json", marks), [
    "old:2",
    "new:2",
    "new:3",
  ]);
  assert.deepEqual(markedLines(snapshot, "src/a.ts", marks), []);
  const mark = marks.get(
    changedLineKey({
      fileChangeId: changeAt(snapshot, "package-lock.json").id,
      side: "new",
      line: 3,
    }),
  );
  assert.deepEqual(mark, { reason: "excluded-path", pattern: "*-lock.json" });
});

test("generated-attribute marks the file; excluded-path wins when both apply", () => {
  const snapshot = makeSnapshot("snapshot-generated", [
    { path: "gen/schema.ts", lines: [" head", "+generated", " tail"] },
    { path: "gen/both.ts", lines: [" head", "+generated", " tail"] },
  ]);
  const marks = computeExclusions(snapshot, {
    excludedPaths: new Map([["gen/both.ts", "gen/both.ts"]]),
    generatedPaths: new Set(["gen/schema.ts", "gen/both.ts"]),
  });
  const schema = marks.get(
    changedLineKey({
      fileChangeId: changeAt(snapshot, "gen/schema.ts").id,
      side: "new",
      line: 2,
    }),
  );
  assert.deepEqual(schema, { reason: "generated-attribute" });
  const both = marks.get(
    changedLineKey({
      fileChangeId: changeAt(snapshot, "gen/both.ts").id,
      side: "new",
      line: 2,
    }),
  );
  assert.equal(both?.reason, "excluded-path");
});

test("a file excluded by path does not also run the whitespace rule", () => {
  const snapshot = makeSnapshot("snapshot-precedence", [
    { path: "a.lock", lines: [" head", "-x  ", "+x", " tail"] },
  ]);
  const marks = computeExclusions(snapshot, {
    excludedPaths: new Map([["a.lock", "*.lock"]]),
    generatedPaths: new Set(),
  });
  for (const mark of marks.values()) {
    assert.equal(mark.reason, "excluded-path");
  }
  assert.equal(marks.size, 2);
});

test("exclusionPath judges a rename by its destination and a deletion by its origin", () => {
  const renamed = makeFileChange({
    path: "new.lock",
    oldPath: "old.lock",
    status: "renamed",
    lines: [" a"],
  });
  assert.equal(exclusionPath(renamed), "new.lock");
  const deleted = makeFileChange({
    path: "gone.lock",
    status: "deleted",
    lines: ["-a"],
  });
  assert.equal(exclusionPath(deleted), "gone.lock");
});

test("binary and unsupported changes produce no exclusions", () => {
  const snapshot = makeSnapshot("snapshot-binary", [], {
    changes: [
      {
        id: "file:binary" as FileChange["id"],
        source: "tracked",
        status: "modified",
        oldPath: "a.lock",
        newPath: "a.lock",
        gitHeaderLines: [],
        content: {
          type: "binary",
          gitBodyLines: [],
          unsupportedReason: "binary file",
        },
      },
    ],
  });
  const marks = computeExclusions(snapshot, {
    excludedPaths: new Map([["a.lock", "*.lock"]]),
    generatedPaths: new Set(),
  });
  assert.equal(marks.size, 0);
});

test("describeExclusion names the rule and quotes the pattern", () => {
  assert.equal(
    describeExclusion({ reason: "excluded-path", pattern: "*.lock" }),
    'matches exclude pattern "*.lock"',
  );
  assert.equal(
    describeExclusion({ reason: "generated-attribute" }),
    "marked linguist-generated in Git attributes",
  );
  assert.equal(
    describeExclusion({ reason: "whitespace-only" }),
    "whitespace-only change",
  );
});
