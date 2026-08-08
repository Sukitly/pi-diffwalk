import assert from "node:assert/strict";
import test from "node:test";
import {
  listCommentTargets,
  REVIEW_COMMENT_CONTEXT_RADIUS,
  type ReviewCommentAnchor,
  ReviewCommentInputError,
  ReviewSession,
  ReviewSessionError,
} from "../src/review-comments.ts";
import { computeReviewDelta } from "../src/review-delta.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  ReviewRoute,
  ReviewSnapshot,
  ReviewSpan,
  ReviewUnitId,
} from "../src/types.ts";
import {
  type FileFixture,
  fileChangeId,
  makeSnapshot,
  span,
} from "./domain-fixtures.ts";

interface Fixture {
  readonly snapshot: ReviewSnapshot;
  readonly route: ReviewRoute;
  readonly unitId: ReviewUnitId;
}

function build(
  id: string,
  files: readonly FileFixture[],
  unitSpans: readonly (readonly ReviewSpan[])[],
): Fixture {
  const snapshot = makeSnapshot(id, files);
  const delta = computeReviewDelta(snapshot);
  const route = validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units: unitSpans.map((spans, index) => ({
      title: `Review unit ${index + 1}`,
      whyHere: `Unit ${index + 1} follows the behavioral review order.`,
      context: `entry -> unit${index + 1} -> result`,
      changeSummary: `Unit ${index + 1} changes its part of the result.`,
      reviewFocus: [`Does unit ${index + 1} preserve its contract?`],
      spans: [...spans],
    })),
    skippedSpans: [],
  });
  const unit = route.units[0];
  assert.ok(unit);
  return { snapshot, route, unitId: unit.id };
}

const COMMENT_PATH = "src/space and 文\nfile.ts";

function commentFixture(): Fixture {
  return build(
    "snapshot-comments",
    [
      {
        path: COMMENT_PATH,
        lines: [
          " const before = true",
          "-const removed = 1",
          "+const added = 1",
          " callContract()",
          "-return oldValue",
          "+return newValue",
          " }",
          " export { result }",
        ],
      },
    ],
    [[span(COMMENT_PATH, { old: [1, 6], new: [1, 6] })]],
  );
}

function anchor(
  fixture: Fixture,
  path: string,
  side: "old" | "new",
  line: number,
): ReviewCommentAnchor {
  return {
    reviewUnitId: fixture.unitId,
    fileChangeId: fileChangeId("modified", path),
    side,
    line,
  };
}

test("offers every changed line inside a unit span as a comment target", () => {
  const fixture = commentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const targets = session.listCommentableLines();

  assert.deepEqual(
    targets.map((target) => [target.side, target.line, target.diffLine.text]),
    [
      ["old", 2, "const removed = 1"],
      ["new", 2, "const added = 1"],
      ["old", 4, "return oldValue"],
      ["new", 4, "return newValue"],
    ],
  );
  assert.equal(targets[0]?.filePath, COMMENT_PATH);
  assert.deepEqual(
    listCommentTargets(fixture.snapshot, fixture.route),
    targets,
  );
});

test("does not offer context lines or lines outside the route", () => {
  const fixture = build(
    "snapshot-partial",
    [{ path: "src/a.ts", lines: [" head", "+first", " middle", "+second"] }],
    [[span("src/a.ts", { new: [1, 2] })], [span("src/a.ts", { new: [4, 4] })]],
  );
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.deepEqual(
    session
      .listCommentableLines()
      .filter((target) => target.reviewUnitId === fixture.unitId)
      .map((target) => target.line),
    [2],
  );
});

test("anchors added and removed comments to independent line numbers", () => {
  const fixture = commentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  const removed = session.upsertComment({
    ...anchor(fixture, COMMENT_PATH, "old", 2),
    body: "Removed line.",
  });
  const added = session.upsertComment({
    ...anchor(fixture, COMMENT_PATH, "new", 2),
    body: "Added line.",
  });

  assert.deepEqual(
    { oldLine: removed.oldLine, newLine: removed.newLine },
    { oldLine: 2, newLine: undefined },
  );
  assert.deepEqual(
    { oldLine: added.oldLine, newLine: added.newLine },
    { oldLine: undefined, newLine: 2 },
  );
  assert.equal(removed.selectedText, "const removed = 1");
});

test("retains old and new paths when commenting on a renamed file", () => {
  const snapshot = makeSnapshot("snapshot-rename", [
    {
      path: "src/new-name.ts",
      oldPath: "src/old-name.ts",
      status: "renamed",
      lines: [
        "-export const oldName = true",
        "+export const newName = true",
        " export const stable = true",
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const route = validateReviewRoute(snapshot, delta, {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Rename",
        whyHere: "The declaration moved.",
        context: "old -> new",
        changeSummary: "Renames the declaration.",
        reviewFocus: ["Are callers updated?"],
        spans: [span("src/new-name.ts", { old: [1, 1], new: [1, 1] })],
      },
    ],
    skippedSpans: [],
  });
  const unit = route.units[0];
  assert.ok(unit);
  const session = new ReviewSession(snapshot, route);

  const removed = session.upsertComment({
    reviewUnitId: unit.id,
    fileChangeId: fileChangeId("renamed", "src/new-name.ts"),
    side: "old",
    line: 1,
    body: "Removed declaration.",
  });
  const added = session.upsertComment({
    reviewUnitId: unit.id,
    fileChangeId: fileChangeId("renamed", "src/new-name.ts"),
    side: "new",
    line: 1,
    body: "Added declaration.",
  });

  for (const comment of [removed, added]) {
    assert.equal(comment.oldPath, "src/old-name.ts");
    assert.equal(comment.newPath, "src/new-name.ts");
  }
  assert.equal(removed.filePath, "src/old-name.ts");
  assert.equal(added.filePath, "src/new-name.ts");
});

test("offers and saves nearby context from the whole frozen file", () => {
  const fixture = commentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const target = session
    .listCommentableLines()
    .find((candidate) => candidate.side === "new" && candidate.line === 4);
  assert.ok(target);

  const comment = session.upsertComment({
    ...anchor(fixture, COMMENT_PATH, "new", 4),
    body: "Check the new return value.",
  });

  assert.equal(REVIEW_COMMENT_CONTEXT_RADIUS, 3);
  assert.deepEqual(
    target.context.lines.map((line) => line.text),
    [
      "const added = 1",
      "callContract()",
      "return oldValue",
      "return newValue",
      "}",
      "export { result }",
    ],
  );
  assert.equal(target.context.anchorIndex, 3);
  assert.equal(target.context.fileStartIndex, 2);
  assert.deepEqual(comment.nearbyContext, target.context.lines);
});

test("orders comments by route order across units and files", () => {
  const fixture = build(
    "snapshot-order",
    [
      { path: "src/first.ts", lines: [" head", "+first"] },
      { path: "src/second.ts", lines: [" head", "+second"] },
    ],
    [
      [span("src/second.ts", { new: [2, 2] })],
      [span("src/first.ts", { new: [2, 2] })],
    ],
  );
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const [firstUnit, secondUnit] = fixture.route.units;
  assert.ok(firstUnit);
  assert.ok(secondUnit);

  session.upsertComment({
    reviewUnitId: secondUnit.id,
    fileChangeId: fileChangeId("modified", "src/first.ts"),
    side: "new",
    line: 2,
    body: "Created first but routed second.",
  });
  session.upsertComment({
    reviewUnitId: firstUnit.id,
    fileChangeId: fileChangeId("modified", "src/second.ts"),
    side: "new",
    line: 2,
    body: "Created second but routed first.",
  });

  assert.deepEqual(
    session.getComments().map((comment) => comment.filePath),
    ["src/second.ts", "src/first.ts"],
  );
});

test("finds, replaces, and deletes a comment by its frozen anchor", () => {
  const fixture = commentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);
  const target = anchor(fixture, COMMENT_PATH, "new", 2);

  session.upsertComment({ ...target, body: "Original question." });
  assert.equal(session.getComment(target)?.body, "Original question.");

  session.upsertComment({ ...target, body: "Updated question." });
  assert.equal(session.getComments().length, 1);
  assert.equal(session.getComments()[0]?.body, "Updated question.");

  assert.deepEqual(session.deleteComment(target), { deleted: true });
  assert.deepEqual(session.getComments(), []);
  assert.deepEqual(session.deleteComment(target), { deleted: false });
});

test("rejects a blank body and an anchor the route does not cover", () => {
  const fixture = commentFixture();
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture, COMMENT_PATH, "new", 2),
        body: " \t",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewCommentInputError);
      assert.equal(error.code, "blank-comment-body");
      return true;
    },
  );

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture, COMMENT_PATH, "new", 99),
        body: "Stale selection.",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSessionError);
      assert.equal(error.code, "unknown-comment-anchor");
      assert.match(error.message, /line 99/);
      return true;
    },
  );

  assert.throws(
    () =>
      session.upsertComment({
        ...anchor(fixture, COMMENT_PATH, "new", 1),
        body: "Context line.",
      }),
    ReviewSessionError,
  );
});

test("does not mutate the snapshot or route supplied to the session", () => {
  const fixture = commentFixture();
  const snapshotBefore = structuredClone(fixture.snapshot);
  const routeBefore = structuredClone(fixture.route);
  const session = new ReviewSession(fixture.snapshot, fixture.route);

  session.upsertComment({
    ...anchor(fixture, COMMENT_PATH, "new", 2),
    body: "Immutable inputs.",
  });
  session.getComments();

  assert.deepEqual(fixture.snapshot, snapshotBefore);
  assert.deepEqual(fixture.route, routeBefore);
});
