import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_COMMENT_CONTEXT_RADIUS,
  type ReviewCommentAnchor,
  ReviewCommentInputError,
  ReviewSession,
  ReviewSessionError,
} from "../src/review-comments.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  DiffLine,
  HunkId,
  ReviewRoute,
  ReviewSnapshot,
  ReviewUnitId,
} from "../src/types.ts";
import { hunkId, makeSnapshot } from "./domain-fixtures.ts";

interface CommentFixture {
  readonly snapshot: ReviewSnapshot;
  readonly route: ReviewRoute;
  readonly unitId: ReviewUnitId;
}

function makeCommentFixture(): CommentFixture {
  const path = "src/space and 文\nfile.ts";
  const base = makeSnapshot("snapshot-comments", [
    { id: "h-comment", fingerprint: "fp-comment", path, start: 10 },
  ]);
  const lines: readonly DiffLine[] = [
    {
      index: 0,
      kind: "context",
      raw: " const before = true",
      oldLine: 10,
      newLine: 10,
    },
    {
      index: 1,
      kind: "removed",
      raw: "-const removed = 1",
      oldLine: 11,
    },
    {
      index: 2,
      kind: "added",
      raw: "+const added = 1",
      newLine: 11,
    },
    {
      index: 3,
      kind: "context",
      raw: " callContract()",
      oldLine: 12,
      newLine: 12,
    },
    {
      index: 4,
      kind: "removed",
      raw: "-return oldValue",
      oldLine: 13,
    },
    {
      index: 5,
      kind: "added",
      raw: "+return newValue",
      newLine: 13,
    },
    {
      index: 6,
      kind: "context",
      raw: " }",
      oldLine: 14,
      newLine: 14,
    },
    {
      index: 7,
      kind: "context",
      raw: " export { result }",
      oldLine: 15,
      newLine: 15,
    },
    {
      index: 8,
      kind: "no-newline-marker",
      raw: "\\ No newline at end of file",
    },
  ];
  const snapshot = replaceHunkLines(
    base,
    new Map([[hunkId("h-comment"), lines]]),
  );
  const route = makeRoute(snapshot, [[hunkId("h-comment")]]);
  return {
    snapshot,
    route,
    unitId: requiredAt(route.units, 0, "review unit").id,
  };
}

function makeRenamedFixture(): CommentFixture {
  const base = makeSnapshot("snapshot-rename", [
    {
      id: "h-rename",
      fingerprint: "fp-rename",
      path: "src/new-name.ts",
      status: "renamed",
    },
  ]);
  const change = requiredAt(base.changes, 0, "renamed file change");
  if (change.content.kind !== "text") {
    throw new Error("Expected a text rename fixture.");
  }
  const hunk = requiredAt(change.content.hunks, 0, "rename hunk");
  const snapshot: ReviewSnapshot = {
    ...base,
    changes: [
      {
        ...change,
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
        content: {
          kind: "text",
          hunks: [
            {
              ...hunk,
              lines: [
                {
                  index: 0,
                  kind: "removed",
                  raw: "-export const oldName = true",
                  oldLine: 1,
                },
                {
                  index: 1,
                  kind: "added",
                  raw: "+export const newName = true",
                  newLine: 1,
                },
                {
                  index: 2,
                  kind: "context",
                  raw: " export const stable = true",
                  oldLine: 2,
                  newLine: 2,
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const route = makeRoute(snapshot, [[hunkId("h-rename")]]);
  return {
    snapshot,
    route,
    unitId: requiredAt(route.units, 0, "rename review unit").id,
  };
}

function makeOrderedFixture(): {
  readonly snapshot: ReviewSnapshot;
  readonly route: ReviewRoute;
} {
  const base = makeSnapshot("snapshot-order", [
    { id: "h-first", fingerprint: "fp-first", path: "src/first.ts" },
    { id: "h-second", fingerprint: "fp-second", path: "src/second.ts" },
  ]);
  const snapshot = replaceHunkLines(
    base,
    new Map([
      [
        hunkId("h-first"),
        [
          {
            index: 0,
            kind: "added",
            raw: "+first",
            newLine: 1,
          },
        ],
      ],
      [
        hunkId("h-second"),
        [
          {
            index: 0,
            kind: "added",
            raw: "+second",
            newLine: 1,
          },
        ],
      ],
    ]),
  );
  return {
    snapshot,
    route: makeRoute(snapshot, [[hunkId("h-second")], [hunkId("h-first")]]),
  };
}

function replaceHunkLines(
  snapshot: ReviewSnapshot,
  linesByHunkId: ReadonlyMap<HunkId, readonly DiffLine[]>,
): ReviewSnapshot {
  return {
    ...snapshot,
    changes: snapshot.changes.map((change) =>
      change.content.kind === "text"
        ? {
            ...change,
            content: {
              kind: "text",
              hunks: change.content.hunks.map((hunk) => ({
                ...hunk,
                lines: linesByHunkId.get(hunk.id) ?? hunk.lines,
              })),
            },
          }
        : change,
    ),
  };
}

function makeRoute(
  snapshot: ReviewSnapshot,
  unitHunkIds: readonly (readonly HunkId[])[],
): ReviewRoute {
  return validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: unitHunkIds.map((hunkIds, index) => ({
      title: `Review unit ${index + 1}`,
      whyHere: `Unit ${index + 1} follows the behavioral review order.`,
      context: `entry -> unit${index + 1} -> result`,
      changeSummary: `Unit ${index + 1} changes its part of the result.`,
      reviewFocus: [`Does unit ${index + 1} preserve its contract?`],
      hunkIds: [...hunkIds],
    })),
    skippedHunks: [],
  });
}

function anchor(
  unitId: ReviewUnitId,
  hunk: HunkId,
  diffLineIndex: number,
): ReviewCommentAnchor {
  return { reviewUnitId: unitId, hunkId: hunk, diffLineIndex };
}

test("lists source lines but not no-newline markers as commentable targets", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const targets = session.listCommentableLines();

  assert.equal(targets.length, 8);
  assert.deepEqual(
    targets.map((target) => target.diffLineIndex),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.ok(
    targets.every((target) => target.line.kind !== "no-newline-marker"),
  );
  assert.equal(targets[0]?.filePath, "src/space and 文\nfile.ts");
});

test("rejects a comment anchored to a no-newline marker", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture.unitId, hunkId("h-comment"), 8),
        body: "Marker comment.",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSessionError);
      assert.equal(error.code, "unknown-comment-anchor");
      return true;
    },
  );
});

test("anchors added, removed, and context comments to independent line numbers", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const removed = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 1),
    body: "Removed line.",
  });
  const added = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 2),
    body: "Added line.",
  });
  const context = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 3),
    body: "Context line.",
  });

  assert.deepEqual(
    { oldLine: removed.oldLine, newLine: removed.newLine },
    { oldLine: 11, newLine: undefined },
  );
  assert.deepEqual(
    { oldLine: added.oldLine, newLine: added.newLine },
    { oldLine: undefined, newLine: 11 },
  );
  assert.deepEqual(
    { oldLine: context.oldLine, newLine: context.newLine },
    { oldLine: 12, newLine: 12 },
  );
});

test("retains old and new paths when commenting on a renamed file", () => {
  const fixture = makeRenamedFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const removed = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-rename"), 0),
    body: "Removed declaration.",
  });
  const added = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-rename"), 1),
    body: "Added declaration.",
  });
  const context = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-rename"), 2),
    body: "Stable declaration.",
  });

  for (const comment of [removed, added, context]) {
    assert.equal(comment.oldPath, "src/old-name.ts");
    assert.equal(comment.newPath, "src/new-name.ts");
  }
  assert.equal(removed.filePath, "src/old-name.ts");
  assert.equal(added.filePath, "src/new-name.ts");
  assert.equal(context.filePath, "src/new-name.ts");
});

test("captures nearby diff context by the selected diff line index", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const comment = session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 5),
    body: "Check the new return value.",
  });

  assert.equal(REVIEW_COMMENT_CONTEXT_RADIUS, 3);
  assert.deepEqual(
    comment.nearbyDiffContext.map((line) => line.index),
    [2, 3, 4, 5, 6, 7, 8],
  );
});

test("orders comments by semantic route order across units and hunks", () => {
  const fixture = makeOrderedFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const firstUnit = requiredAt(fixture.route.units, 0, "first route unit");
  const secondUnit = requiredAt(fixture.route.units, 1, "second route unit");

  session.upsertComment({
    ...anchor(secondUnit.id, hunkId("h-first"), 0),
    body: "Created first but routed second.",
  });
  session.upsertComment({
    ...anchor(firstUnit.id, hunkId("h-second"), 0),
    body: "Created second but routed first.",
  });

  assert.deepEqual(
    session.getComments().map((comment) => comment.hunkId),
    [hunkId("h-second"), hunkId("h-first")],
  );
});

test("finds a comment by its frozen diff anchor", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const commentAnchor = anchor(fixture.unitId, hunkId("h-comment"), 3);
  session.upsertComment({ ...commentAnchor, body: "Anchored question." });

  assert.equal(session.getComment(commentAnchor)?.body, "Anchored question.");
  assert.equal(
    session.getComment(anchor(fixture.unitId, hunkId("h-comment"), 4)),
    undefined,
  );
});

test("editing a comment replaces its body without duplicating its anchor", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const commentAnchor = anchor(fixture.unitId, hunkId("h-comment"), 3);

  session.upsertComment({ ...commentAnchor, body: "Original question." });
  session.upsertComment({ ...commentAnchor, body: "Updated question." });

  assert.equal(session.getComments().length, 1);
  assert.equal(session.getComments()[0]?.body, "Updated question.");
});

test("rejects a blank comment body with a user-correctable code", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture.unitId, hunkId("h-comment"), 3),
        body: " \t",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewCommentInputError);
      assert.equal(error.code, "blank-comment-body");
      return true;
    },
  );
});

test("rejects a stale comment anchor with a session error code", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture.unitId, hunkId("h-comment"), 99),
        body: "Stale selection.",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSessionError);
      assert.equal(error.code, "unknown-comment-anchor");
      assert.match(error.message, /line index 99/);
      return true;
    },
  );
});

test("deleting an existing comment reports that it was deleted", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const commentAnchor = anchor(fixture.unitId, hunkId("h-comment"), 1);
  session.upsertComment({ ...commentAnchor, body: "Delete this." });

  assert.deepEqual(session.deleteComment(commentAnchor), { deleted: true });
  assert.deepEqual(session.getComments(), []);
});

test("deleting a missing or stale comment is idempotent", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.deepEqual(
    session.deleteComment(anchor(fixture.unitId, hunkId("h-comment"), 1)),
    { deleted: false },
  );
  assert.deepEqual(
    session.deleteComment(anchor(fixture.unitId, hunkId("unknown"), 99)),
    { deleted: false },
  );
});

test("submits the complete comment batch only after snapshot verification", async () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 2),
    body: "Confirm compatibility.",
  });
  let verifiedSnapshotId: string | undefined;
  let verifierSignal: AbortSignal | undefined;
  const controller = new AbortController();

  const result = await session.submit(
    "discuss-first",
    async (snapshot, signal) => {
      verifiedSnapshotId = snapshot.id;
      verifierSignal = signal;
    },
    controller.signal,
  );

  assert.equal(verifiedSnapshotId, fixture.snapshot.id);
  assert.equal(verifierSignal, controller.signal);
  assert.equal(result.status, "submitted");
  assert.equal(result.submissionMode, "discuss-first");
  assert.equal(result.comments.length, 1);
});

test("does not submit when verification is aborted", async () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const controller = new AbortController();
  controller.abort(new Error("verification cancelled"));

  await assert.rejects(
    session.submit("discuss-first", async () => {}, controller.signal),
    /verification cancelled/,
  );
});

test("does not create a submission result when snapshot verification fails", async () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 2),
    body: "Blocked comment.",
  });

  await assert.rejects(
    session.submit("apply-change-requests", async () => {
      throw new Error("snapshot drift");
    }),
    /snapshot drift/,
  );
});

test("cancels without returning unsubmitted comments", () => {
  const fixture = makeCommentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 2),
    body: "Unsubmitted draft.",
  });

  assert.deepEqual(session.cancel(), {
    status: "cancelled",
    snapshotId: fixture.snapshot.id,
  });
});

test("does not mutate the snapshot or route supplied to the session", async () => {
  const fixture = makeCommentFixture();
  const snapshotBefore = structuredClone(fixture.snapshot);
  const routeBefore = structuredClone(fixture.route);
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  session.upsertComment({
    ...anchor(fixture.unitId, hunkId("h-comment"), 2),
    body: "Immutable inputs.",
  });
  await session.submit("discuss-first", async () => {});

  assert.deepEqual(fixture.snapshot, snapshotBefore);
  assert.deepEqual(fixture.route, routeBefore);
});

function requiredAt<Value>(
  values: readonly Value[],
  index: number,
  label: string,
): Value {
  const value = values[index];
  if (value === undefined)
    throw new Error(`Missing ${label} at index ${index}.`);
  return value;
}
