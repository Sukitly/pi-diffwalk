import assert from "node:assert/strict";
import test from "node:test";
import {
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
} from "../../src/extension/tui-messages.ts";
import { ReviewSnapshotDriftError } from "../../src/git/errors.ts";
import { DIFFWALK_THREAD_BATCH_ENTRY_TYPE } from "../../src/review/thread-persistence.ts";
import type {
  GuidedReviewResult,
  ReviewRouteCandidate,
} from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import {
  commandContext,
  createHarness,
  renderedToolResult,
  toolContext,
  toolResultWithoutDetails,
  validRoute,
} from "./harness.ts";

test("requires /diffwalk before any route tool and validates the route", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.submitRoute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending.*run \/diffwalk first/,
  );

  await harness.command(" origin/main ", commandContext());
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0] ?? "", /Prepare a semantic route/);
  assert.match(harness.sentMessages[0] ?? "", /"targetRef": "origin\/main"/);
  assert.deepEqual(harness.sentMessageMeta[0], {
    customType: DIFFWALK_KICKOFF_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });

  await assert.rejects(
    harness.submitRoute(
      "call-3",
      { ...validRoute(), units: [] },
      undefined,
      undefined,
      toolContext(),
    ),
    /Invalid review route:[\s\S]*src\/file\.ts new 2-2[\s\S]*must contain at least one review unit with spans/,
  );

  const completed = await harness.submitRoute(
    "call-4",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "paused",
    snapshotId: "snapshot-index",
  });
  assert.equal(completed.terminate, true);

  await harness.command("", commandContext());
  assert.deepEqual(harness.openedSnapshots, [
    "snapshot-index",
    "snapshot-index",
  ]);
  assert.equal(harness.sentMessages.length, 1);

  await assert.rejects(
    harness.submitRoute(
      "call-5",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /already has a validated route.*resume it/,
  );
});

test("terminates the initial tool turn when the review is discarded", async () => {
  const harness = createHarness({ discardOnOpen: true });
  await harness.command("", commandContext());

  const discarded = await harness.submitRoute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  assert.deepEqual(discarded.details, {
    status: "discarded",
    snapshotId: "snapshot-index",
  });
  assert.equal(discarded.terminate, true);
});

test("continues the initial tool turn when a submitted review has comments", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());

  const submitted = await harness.submitRoute(
    "call-1",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const details = submitted.details as Extract<
    GuidedReviewResult,
    { status: "submitted" }
  >;
  assert.equal(details.status, "submitted");
  assert.equal(details.comments.length, 1);
  assert.equal(submitted.terminate, false);
});

test("accepts complete structured responses and opens anchored threads", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted") throw new Error("Expected submission.");
  assert.ok(result.commentBatchId);
  assert.ok(harness.responseTool.prepareArguments);
  assert.deepEqual(
    harness.responseTool.prepareArguments({
      batchId: result.commentBatchId,
      responses: [{ commentId: "C1", body: "Legacy response." }],
    }),
    {
      responses: [{ threadId: "C1", body: "Legacy response." }],
    },
  );

  const responses = await harness.responseTool.execute(
    "call-responses",
    {
      responses: [{ threadId: "C1", body: "The behavior is intentional." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(responses.terminate, true);
  assert.equal(
    responses.details?.batch.turns[0]?.items[0]?.agentResponse?.body,
    "The behavior is intentional.",
  );
  assert.deepEqual(harness.openedThreadBatches, [result.commentBatchId]);
  assert.equal(
    harness.appendedEntries.filter(
      (entry) => entry.customType === DIFFWALK_THREAD_BATCH_ENTRY_TYPE,
    ).length,
    2,
  );
});

test("continues the Agent turn when the reviewer submits an inline follow-up", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
    submitFollowUpOnThreadOpen: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }

  const firstResponse = await harness.responseTool.execute(
    "call-responses-1",
    {
      responses: [{ threadId: "C1", body: "Initial answer." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  assert.equal(firstResponse.terminate, false);
  assert.equal(firstResponse.details?.status, "follow-up-submitted");
  assert.equal(
    firstResponse.details?.status === "follow-up-submitted"
      ? firstResponse.details.turnId
      : undefined,
    "T2",
  );
  const followUpPayload = firstResponse.content.find(
    (item) => item.type === "text",
  );
  assert.equal(followUpPayload?.type, "text");
  if (followUpPayload?.type !== "text") throw new Error("Expected text.");
  assert.match(followUpPayload.text, /"turnId":"T2"/);
  assert.match(followUpPayload.text, /Explain that answer further/);
  assert.match(followUpPayload.text, /Initial answer/);

  harness.behavior.submitFollowUpOnThreadOpen = false;
  const secondResponse = await harness.responseTool.execute(
    "call-responses-2",
    {
      responses: [{ threadId: "C1", body: "Further explanation." }],
    },
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(secondResponse.terminate, true);
  assert.equal(secondResponse.details?.status, "closed");
  assert.equal(
    secondResponse.details?.batch.turns[1]?.items[0]?.agentResponse?.body,
    "Further explanation.",
  );
});

test("carries a reviewer-resolved comment forward in the next round", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
    resolveThreadOnOpen: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted" || result.commentBatchId === undefined) {
    throw new Error("Expected a submitted comment batch.");
  }
  await harness.responseTool.execute(
    "call-responses",
    {
      responses: [{ threadId: "C1", body: "Answered." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail", "+new"] },
  ]);
  await harness.command("", commandContext());

  const kickoff = harness.sentMessages.at(-1) ?? "";
  assert.match(kickoff, /"needsReviewLineCount": 1/);
  assert.match(kickoff, /"carriedForwardLineCount": 1/);
  assert.doesNotMatch(kickoff, /"unresolvedComment"[\s\S]*"2"/);
});

test("finishes thread turns before freezing a later review delta", async () => {
  const harness = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await harness.command("", commandContext());
  const submitted = await harness.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  assert.equal(result.status, "submitted");
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }

  harness.behavior.snapshot = makeSnapshot("snapshot-round-2", [
    { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
  ]);
  await assert.rejects(
    harness.command("", commandContext()),
    /unfinished reviewer turn or draft reply/,
  );

  await harness.responseTool.execute(
    "call-responses",
    {
      responses: [{ threadId: "C1", body: "Answered." }],
    },
    undefined,
    undefined,
    toolContext(),
  );
  await harness.command("", commandContext());
  await assert.rejects(
    harness.command("--threads", commandContext()),
    /baseline of pending review.*Finish or discard/,
  );
});

test("reopens the latest persisted comment threads", async () => {
  const first = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await first.command("", commandContext());
  await first.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );

  const second = createHarness();
  await second.restoreSession(first.appendedEntries);
  await second.command("--threads", commandContext());

  assert.equal(second.openedThreadBatches.length, 1);
});

test("starts an Agent turn for a follow-up submitted from /diffwalk --threads", async () => {
  const first = createHarness({
    submitOnOpen: true,
    commentOnSubmit: true,
  });
  await first.command("", commandContext());
  const submitted = await first.submitRoute(
    "call-review",
    validRoute(),
    undefined,
    undefined,
    toolContext(),
  );
  const result = submitted.details;
  if (
    result.status !== "submitted" ||
    result.commentBatchId === undefined ||
    result.commentTurnId === undefined
  ) {
    throw new Error("Expected a submitted comment turn.");
  }
  await first.responseTool.execute(
    "call-response",
    {
      responses: [{ threadId: "C1", body: "Initial answer." }],
    },
    undefined,
    undefined,
    toolContext(),
  );

  const second = createHarness({ submitFollowUpOnThreadOpen: true });
  await second.restoreSession(first.appendedEntries);
  await second.command("--threads", commandContext());

  const meta = second.sentMessageMeta.at(-1);
  assert.deepEqual(meta, {
    customType: DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
    display: true,
    triggerTurn: true,
  });
  assert.match(second.sentMessages.at(-1) ?? "", /"turnId":"T2"/);
  assert.match(second.sentMessages.at(-1) ?? "", /Explain that answer further/);
});

test("lists detected moves in the kickoff and accepts a route that splits one", async () => {
  const movedBlock = [
    "const total = computeTotalAmount(items);",
    "const tax = totalAmount * currentTaxRate;",
    "return { totalAmount, taxAmount: tax };",
  ];
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-index", [
      {
        path: "src/from.ts",
        lines: [" head", ...movedBlock.map((line) => `-${line}`), " tail"],
      },
      {
        path: "src/to.ts",
        lines: [" top", ...movedBlock.map((line) => `+${line}`), " bottom"],
      },
    ]),
  });
  await harness.command("", commandContext());
  assert.match(
    harness.sentMessages[0] ?? "",
    /`moves` lists exact relocations/,
  );

  const splitRoute: ReviewRouteCandidate = {
    snapshotId: "snapshot-index",
    units: [
      {
        title: "Removal",
        whyHere: "Old site first.",
        context: "from -> to",
        changeSummary: "Removes the block.",
        reviewFocus: [{ question: "Is the removal safe?" }],
        spans: [span("src/from.ts", { old: [2, 4] })],
      },
      {
        title: "Addition",
        whyHere: "New site second.",
        context: "from -> to",
        changeSummary: "Adds the block.",
        reviewFocus: [{ question: "Is the addition safe?" }],
        spans: [span("src/to.ts", { new: [2, 4] })],
      },
    ],
    skippedSpans: [],
  };

  const completed = await harness.submitRoute(
    "call-1",
    splitRoute,
    undefined,
    undefined,
    toolContext(),
  );
  assert.deepEqual(completed.details, {
    status: "paused",
    snapshotId: "snapshot-index",
  });
  assert.deepEqual(harness.openedSnapshots, ["snapshot-index"]);
});

test("rejects repository drift before opening the walkthrough", async () => {
  const harness = createHarness({ drift: true });
  await harness.command("", commandContext());

  let driftMessage: string | undefined;
  await assert.rejects(
    harness.submitRoute(
      "call-drift",
      validRoute(),
      new AbortController().signal,
      undefined,
      toolContext(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ReviewSnapshotDriftError);
      driftMessage = error.message;
      assert.match(
        error.message,
        /Run \/diffwalk again before opening DiffWalk/,
      );
      return true;
    },
  );
  assert.ok(driftMessage);
  const renderedDrift = renderedToolResult(
    harness.tool,
    toolResultWithoutDetails(driftMessage),
    true,
  );
  assert.doesNotMatch(renderedDrift, /needs attention/);
  assert.match(renderedDrift, /Run \/diffwalk again before opening DiffWalk/);
  assert.doesNotMatch(renderedDrift, /snapshotId|submissionMode|instruction/);
  assert.deepEqual(harness.openedSnapshots, []);

  await assert.rejects(
    harness.submitRoute(
      "call-stale",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /No DiffWalk snapshot is pending/,
  );
});

test("submits through the domain pipeline against the captured repository state", async () => {
  const harness = createHarness({ submissionDrift: true });
  harness.behavior.submitOnOpen = true;
  await harness.command("", commandContext());

  await assert.rejects(
    harness.submitRoute(
      "call-1",
      validRoute(),
      undefined,
      undefined,
      toolContext(),
    ),
    /no longer matches review snapshot/,
  );
});

test("rejects a routine reference that is not a repository file, then accepts a corrected one", async () => {
  const harness = createHarness({ existingReferencePaths: ["src/pattern.ts"] });
  // --no-skip keeps the routine unit in the walkthrough, so the reference
  // check is what decides the outcome here.
  await harness.command("--no-skip", commandContext());
  const routineRoute = (reference: string) => {
    const base = validRoute();
    const unit = base.units[0];
    assert.ok(unit);
    return {
      ...base,
      units: [
        { ...unit, routine: { reference, reason: "Mirrors the pattern." } },
      ],
    };
  };

  await assert.rejects(
    harness.submitRoute(
      "call-missing",
      routineRoute("src/missing.ts:3-9"),
      undefined,
      undefined,
      toolContext(),
    ),
    /Routine references must name existing code:[\s\S]*Review unit 1 routine\.reference names "src\/missing\.ts"/,
  );
  assert.deepEqual(harness.openedSnapshots, []);

  harness.behavior.submitOnOpen = true;
  const result = await harness.submitRoute(
    "call-ok",
    routineRoute("src/pattern.ts:3-9"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(harness.openedSnapshots.length, 1);
  assert.equal(
    (result.details as { status?: string } | undefined)?.status ?? "submitted",
    "submitted",
  );
});

test("appends units one at a time and keeps accepted ones after a rejection", async () => {
  const harness = createHarness({
    snapshot: makeSnapshot("snapshot-index", [
      { path: "src/file.ts", lines: [" head", "+changed", " tail"] },
      { path: "src/other.ts", lines: [" head", "+second", " tail"] },
    ]),
  });
  await harness.command("", commandContext());
  const unitCall = (title: string, path: string) => ({
    title,
    whyHere: "Behavior starts here.",
    context: "entry -> implementation",
    changeSummary: "Updates behavior.",
    reviewFocus: [{ question: "Is the behavior correct?" }],
    spans: [span(path, { new: [2, 2] })],
  });

  const first = await harness.unitTool.execute(
    "unit-1",
    unitCall("Entry point", "src/file.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(first.details?.unitCount, 1);
  assert.deepEqual(first.details?.remaining, [
    { path: "src/other.ts", ranges: ["new 2"], lineCount: 1 },
  ]);

  await assert.rejects(
    harness.unitTool.execute(
      "unit-2",
      unitCall("Covers the same line", "src/file.ts"),
      undefined,
      undefined,
      toolContext(),
    ),
    /is covered by review units 1, 2/,
  );
  await assert.rejects(
    harness.tool.execute(
      "finish-early",
      {},
      undefined,
      undefined,
      toolContext(),
    ),
    /src\/other\.ts new 2-2 needs review but no unit covers it/,
  );

  const second = await harness.unitTool.execute(
    "unit-3",
    unitCall("Second file", "src/other.ts"),
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(second.details?.unitCount, 2);
  assert.deepEqual(second.details?.remaining, []);

  harness.behavior.submitOnOpen = true;
  const finished = await harness.tool.execute(
    "finish",
    {},
    undefined,
    undefined,
    toolContext(),
  );
  assert.equal(harness.openedSnapshots.length, 1);
  assert.equal(finished.details?.status, "submitted");
});
