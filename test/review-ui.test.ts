import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../src/review-delta.ts";
import {
  createGuidedReviewCancellation,
  createGuidedReviewSubmission,
  deleteReviewComment,
  listReviewDiffLines,
  REVIEW_COMMENT_CONTEXT_RADIUS,
  type ReviewCommentAnchor,
  ReviewUiStateError,
  upsertReviewComment,
} from "../src/review-ui.ts";
import { validateReviewRoute } from "../src/route-validation.ts";
import type {
  DiffLine,
  ReviewComment,
  ReviewRoute,
  ReviewSnapshot,
  ReviewSubmissionMode,
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
  const change = requiredAt(base.changes, 0, "file change");
  if (change.content.kind !== "text") {
    throw new Error("Expected a text fixture.");
  }
  const hunk = requiredAt(change.content.hunks, 0, "diff hunk");
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
  const snapshot: ReviewSnapshot = {
    ...base,
    changes: [
      {
        ...change,
        content: {
          kind: "text",
          hunks: [
            {
              ...hunk,
              header: {
                raw: "@@ -10,6 +10,6 @@ behavior",
                oldStart: 10,
                oldCount: 6,
                newStart: 10,
                newCount: 6,
              },
              lines,
            },
          ],
        },
      },
    ],
  };
  const route = validateReviewRoute(snapshot, computeReviewDelta(snapshot), {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Behavior and contract",
        whyHere: "The public behavior establishes the review entry point.",
        context: "entry -> callContract -> result",
        changeSummary: "The result now follows the new contract.",
        reviewFocus: ["Does the new result preserve the contract?"],
        hunkIds: [hunk.id],
      },
    ],
    skippedHunks: [],
  });
  const unit = requiredAt(route.units, 0, "review unit");
  return { snapshot, route, unitId: unit.id };
}

function anchor(
  fixture: CommentFixture,
  diffLineIndex: number,
): ReviewCommentAnchor {
  return {
    reviewUnitId: fixture.unitId,
    hunkId: hunkId("h-comment"),
    diffLineIndex,
  };
}

function captureUiError(operation: () => unknown): ReviewUiStateError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ReviewUiStateError);
  return caught;
}

test("materializes commentable diff lines with independent old and new anchors", () => {
  const fixture = makeCommentFixture();
  const snapshotBefore = structuredClone(fixture.snapshot);
  const routeBefore = structuredClone(fixture.route);

  const targets = listReviewDiffLines(fixture.snapshot, fixture.route);

  assert.equal(targets.length, 9);
  assert.deepEqual(targets[0], {
    snapshotId: fixture.snapshot.id,
    reviewUnitId: fixture.unitId,
    hunkId: hunkId("h-comment"),
    diffLineIndex: 0,
    filePath: "src/space and 文\nfile.ts",
    line: {
      index: 0,
      kind: "context",
      raw: " const before = true",
      oldLine: 10,
      newLine: 10,
    },
  });
  assert.deepEqual(targets[1]?.line, {
    index: 1,
    kind: "removed",
    raw: "-const removed = 1",
    oldLine: 11,
  });
  assert.deepEqual(targets[2]?.line, {
    index: 2,
    kind: "added",
    raw: "+const added = 1",
    newLine: 11,
  });
  assert.deepEqual(targets[8]?.line, {
    index: 8,
    kind: "no-newline-marker",
    raw: "\\ No newline at end of file",
  });
  assert.deepEqual(fixture.snapshot, snapshotBefore);
  assert.deepEqual(fixture.route, routeBefore);
});

test("creates, orders, edits, and deletes comments without mutating prior state", () => {
  const fixture = makeCommentFixture();
  const snapshotBefore = structuredClone(fixture.snapshot);
  const routeBefore = structuredClone(fixture.route);
  const withAdded = upsertReviewComment(fixture.snapshot, fixture.route, [], {
    ...anchor(fixture, 5),
    body: "Check the new return value.",
  });
  const withRemoved = upsertReviewComment(
    fixture.snapshot,
    fixture.route,
    withAdded,
    { ...anchor(fixture, 1), body: "Why is the old value removed?" },
  );
  const comments = upsertReviewComment(
    fixture.snapshot,
    fixture.route,
    withRemoved,
    { ...anchor(fixture, 3), body: "  Preserve surrounding whitespace.  " },
  );

  assert.deepEqual(
    comments.map((comment) => comment.diffLineIndex),
    [1, 3, 5],
  );
  assert.deepEqual(
    pickAnchorFields(requiredAt(comments, 0, "removed comment")),
    {
      filePath: "src/space and 文\nfile.ts",
      oldLine: 11,
      newLine: undefined,
      selectedDiffText: "-const removed = 1",
    },
  );
  assert.deepEqual(
    pickAnchorFields(requiredAt(comments, 1, "context comment")),
    {
      filePath: "src/space and 文\nfile.ts",
      oldLine: 12,
      newLine: 12,
      selectedDiffText: " callContract()",
    },
  );
  assert.equal(comments[1]?.body, "  Preserve surrounding whitespace.  ");
  assert.deepEqual(pickAnchorFields(requiredAt(comments, 2, "added comment")), {
    filePath: "src/space and 文\nfile.ts",
    oldLine: undefined,
    newLine: 13,
    selectedDiffText: "+return newValue",
  });
  assert.equal(REVIEW_COMMENT_CONTEXT_RADIUS, 3);
  assert.deepEqual(
    comments[2]?.nearbyDiffContext.map((line) => line.index),
    [2, 3, 4, 5, 6, 7, 8],
  );

  const edited = upsertReviewComment(
    fixture.snapshot,
    fixture.route,
    comments,
    { ...anchor(fixture, 3), body: "Updated contract question." },
  );
  assert.equal(edited.length, 3);
  assert.equal(edited[1]?.body, "Updated contract question.");
  assert.equal(comments[1]?.body, "  Preserve surrounding whitespace.  ");

  const deleted = deleteReviewComment(
    fixture.snapshot,
    fixture.route,
    edited,
    anchor(fixture, 1),
  );
  assert.deepEqual(
    deleted.map((comment) => comment.diffLineIndex),
    [3, 5],
  );
  assert.equal(edited.length, 3);
  assert.deepEqual(
    deleteReviewComment(
      fixture.snapshot,
      fixture.route,
      deleted,
      anchor(fixture, 0),
    ),
    deleted,
  );
  assert.deepEqual(fixture.snapshot, snapshotBefore);
  assert.deepEqual(fixture.route, routeBefore);
});

test("creates structured submission and cancellation results from one comment batch", () => {
  const fixture = makeCommentFixture();
  const comments = upsertReviewComment(fixture.snapshot, fixture.route, [], {
    ...anchor(fixture, 2),
    body: "Confirm compatibility.",
  });

  const discuss = createGuidedReviewSubmission(
    fixture.snapshot,
    fixture.route,
    comments,
    "discuss-first",
  );
  const apply = createGuidedReviewSubmission(
    fixture.snapshot,
    fixture.route,
    comments,
    "apply-change-requests",
  );
  const cancelled = createGuidedReviewCancellation(
    fixture.snapshot,
    fixture.route,
    comments,
  );

  assert.deepEqual(discuss, {
    status: "submitted",
    snapshotId: fixture.snapshot.id,
    submissionMode: "discuss-first",
    comments,
  });
  assert.deepEqual(apply, {
    status: "submitted",
    snapshotId: fixture.snapshot.id,
    submissionMode: "apply-change-requests",
    comments,
  });
  assert.deepEqual(cancelled, {
    status: "cancelled",
    snapshotId: fixture.snapshot.id,
    comments,
  });
  assert.notStrictEqual(discuss.comments, comments);
  assert.notStrictEqual(discuss.comments[0], comments[0]);
});

test("rejects invalid routes, anchors, bodies, comment state, and submission modes", () => {
  const fixture = makeCommentFixture();
  const validComment = requiredAt(
    upsertReviewComment(fixture.snapshot, fixture.route, [], {
      ...anchor(fixture, 2),
      body: "Valid comment.",
    }),
    0,
    "valid comment",
  );
  const otherSnapshot = makeSnapshot("other-snapshot", []);
  const mismatchedRoute = {
    ...fixture.route,
    snapshotId: otherSnapshot.id,
  };
  assert.match(
    captureUiError(() => listReviewDiffLines(fixture.snapshot, mismatchedRoute))
      .message,
    /references snapshot other-snapshot/,
  );

  const invalidAnchors: readonly ReviewCommentAnchor[] = [
    {
      ...anchor(fixture, 2),
      reviewUnitId: brand<ReviewUnitId>("unknown-unit"),
    },
    { ...anchor(fixture, 2), hunkId: hunkId("unknown-hunk") },
    anchor(fixture, 99),
    anchor(fixture, -1),
  ];
  for (const invalidAnchor of invalidAnchors) {
    assert.throws(
      () =>
        upsertReviewComment(fixture.snapshot, fixture.route, [], {
          ...invalidAnchor,
          body: "Invalid anchor.",
        }),
      ReviewUiStateError,
    );
  }
  assert.throws(
    () =>
      upsertReviewComment(fixture.snapshot, fixture.route, [], {
        ...anchor(fixture, 2),
        body: " \t",
      }),
    /must not be blank/,
  );

  assert.throws(
    () =>
      createGuidedReviewSubmission(
        fixture.snapshot,
        fixture.route,
        [validComment, validComment],
        "discuss-first",
      ),
    /duplicate anchor/,
  );
  assert.throws(
    () =>
      createGuidedReviewCancellation(fixture.snapshot, fixture.route, [
        { ...validComment, filePath: "src/other.ts" },
      ]),
    /does not match the frozen snapshot/,
  );
  assert.throws(
    () =>
      createGuidedReviewCancellation(fixture.snapshot, fixture.route, [
        {
          ...validComment,
          nearbyDiffContext: validComment.nearbyDiffContext.slice(1),
        },
      ]),
    /does not match the frozen snapshot/,
  );
  assert.throws(
    () =>
      createGuidedReviewSubmission(
        fixture.snapshot,
        fixture.route,
        [validComment],
        "invalid-mode" as ReviewSubmissionMode,
      ),
    /Unknown review submission mode/,
  );

  const unit = requiredAt(fixture.route.units, 0, "review unit");
  const unknownHunkRoute: ReviewRoute = {
    ...fixture.route,
    units: [{ ...unit, hunkIds: [hunkId("unknown-hunk")] }],
  };
  assert.throws(
    () => listReviewDiffLines(fixture.snapshot, unknownHunkRoute),
    /references unknown hunk/,
  );
  const duplicateHunkRoute: ReviewRoute = {
    ...fixture.route,
    units: [unit, { ...unit, id: brand<ReviewUnitId>("second-unit") }],
  };
  assert.throws(
    () => listReviewDiffLines(fixture.snapshot, duplicateHunkRoute),
    /references hunk h-comment more than once/,
  );
});

function pickAnchorFields(comment: ReviewComment): {
  readonly filePath: string;
  readonly oldLine: number | undefined;
  readonly newLine: number | undefined;
  readonly selectedDiffText: string;
} {
  return {
    filePath: comment.filePath,
    oldLine: comment.oldLine,
    newLine: comment.newLine,
    selectedDiffText: comment.selectedDiffText,
  };
}

function brand<Value extends string>(value: string): Value {
  return value as Value;
}

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
