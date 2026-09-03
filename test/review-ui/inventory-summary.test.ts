import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import type { ReviewRouteCandidate } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import {
  createHarness,
  press,
  renderText,
  type UiFixture,
  visitEveryUnit,
} from "./harness.ts";

test("shows planned, carried, skipped, metadata, binary, and notice inventory", () => {
  const harness = createHarness(120, 60);

  press(harness.component, "i");
  const output = renderText(harness);
  assert.match(output, /planned:/);
  assert.match(output, /carried-forward:/);
  assert.match(output, /skipped:/);
  assert.match(output, /Generated output is represented/);
  assert.match(output, /metadata-only: mode-changed:.*script\.sh/);
  assert.match(output, /Mode: 100644 -> 100755/);
  assert.match(output, /binary: added:.*asset\.bin/);
  assert.match(output, /binary: deleted:.*removed\.bin/);
  assert.match(output, /2 unsupported/);
  assert.match(output, /notice:.*cancelled\.ts/);
});

test("opens carried-forward frozen hunks for explicit inspection", () => {
  const harness = createHarness(80, 24);
  press(harness.component, "i", "j", "j", "\r");

  const output = renderText(harness);
  assert.match(output, /carried-forward/);
  assert.match(output, /export const carried = true/);

  press(harness.component, "\u001b");
  assert.match(renderText(harness), /Review inventory/);
});

test("continues the first pending section before submission", async () => {
  const harness = createHarness(100, 40);
  press(harness.component, "s");
  assert.match(renderText(harness), /Review incomplete/);

  press(harness.component, "\r");
  assert.deepEqual(harness.submittedModes, []);
  assert.match(renderText(harness), /Continue reviewing this section/);
  assert.match(renderText(harness), /Unit 1\/2/);

  press(harness.component, "n", "n", "\r");
  assert.deepEqual(harness.submittedModes, ["discuss-first"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("ignores mode keys while the summary hides the mode selector", () => {
  const harness = createHarness(100, 40);
  press(harness.component, "s");

  const output = renderText(harness);
  assert.match(output, /Review incomplete/);
  assert.doesNotMatch(output, /Discuss first|Apply change requests/);

  press(harness.component, "\t", "\u001b[C", "l");
  assert.equal(harness.state.review.submissionMode, "discuss-first");

  press(harness.component, "\r", "n", "n");
  assert.match(renderText(harness), /> Discuss first/);
  press(harness.component, "\t");
  assert.match(renderText(harness), /> Apply change requests/);
  assert.deepEqual(harness.submittedModes, []);
});

test("groups skipped regions by reason and file in the summary", () => {
  const snapshot = makeSnapshot("snapshot-skips", [
    { path: "src/a.ts", lines: [" head", "+one", " mid", "+two", " tail"] },
    { path: "src/b.ts", lines: [" head", "-gone", "+three", " tail"] },
    { path: "src/c.ts", lines: [" head", "+four", " tail"] },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Kept",
        whyHere: "Only reviewed region.",
        context: "c",
        changeSummary: "Adds four.",
        reviewFocus: [{ question: "Is four right?" }],
        spans: [span("src/c.ts", { new: [2, 2] })],
      },
    ],
    skippedSpans: [
      { span: span("src/a.ts", { new: [2, 2] }), reason: "Generated." },
      { span: span("src/a.ts", { new: [4, 4] }), reason: "Generated." },
      { span: span("src/b.ts", { old: [2, 2] }), reason: "Generated." },
      { span: span("src/b.ts", { new: [2, 2] }), reason: "Vendored copy." },
    ],
  };
  const fixture: UiFixture = {
    snapshot,
    delta,
    routeCandidate,
    route: validateReviewRoute(snapshot, delta, routeCandidate),
  };
  const harness = createHarness(100, 40, fixture);
  press(harness.component, "n");
  const lines = harness.component.render(100).map((line) => line.trimEnd());
  const start = lines.indexOf("Explicitly skipped regions");

  assert.ok(start > 0);
  assert.deepEqual(lines.slice(start + 1, start + 6), [
    "Generated.",
    "  src/a.ts 2, 4",
    "  src/b.ts old 2",
    "Vendored copy.",
    "  src/b.ts 2",
  ]);
  assert.doesNotMatch(lines.join("\n"), /"src\/a\.ts"|new 2-2/);
});

test("shows the complete batch and selected submission mode", async () => {
  const harness = createHarness(100, 40);
  press(harness.component, "c", "C", "h", "e", "c", "k", "\r", "n", "n");

  let output = renderText(harness);
  assert.match(output, /Comment batch and submission mode/);
  assert.match(output, /> Discuss first/);
  assert.match(output, /Check/);
  assert.match(output, /Explicitly skipped regions/);
  assert.match(output, /Non-text changes and notices/);

  press(harness.component, "\u001b[C");
  output = renderText(harness);
  assert.match(output, /> Apply change requests/);
  press(harness.component, "\r");
  assert.deepEqual(harness.submittedModes, ["apply-change-requests"]);
  await waitForImmediate();
  assert.equal(harness.completedResults.length, 1);
});

test("uses the current summary viewport after a terminal resize", () => {
  const harness = createHarness(80, 20);
  visitEveryUnit(harness.component);
  press(harness.component, "s");
  renderText(harness);

  harness.terminal.rows = 8;
  press(harness.component, "\u001b[6~");

  assert.match(renderText(harness), /No comments were added/);
});
