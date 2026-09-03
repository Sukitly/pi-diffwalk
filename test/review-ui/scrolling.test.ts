import assert from "node:assert/strict";
import test from "node:test";
import { computeReviewDelta } from "../../src/review/delta.ts";
import { validateReviewRoute } from "../../src/review/route-validation.ts";
import type { ReviewRouteCandidate } from "../../src/review/types.ts";
import { makeSnapshot, span } from "../support/domain-fixtures.ts";
import {
  createHarness,
  makeLongExplanationFixture,
  makeTallFixture,
  press,
  renderText,
  spanHeaderTheme,
} from "./harness.ts";

test("pages the complete explanation by its current viewport", () => {
  const harness = createHarness(50, 8, makeLongExplanationFixture());
  press(harness.component, "e");
  const firstPage = renderText(harness);

  press(harness.component, "\u001b[6~");
  const secondPage = renderText(harness);

  assert.notEqual(secondPage, firstPage);
  assert.match(secondPage, /Explanation line [3-9]/);
});

test("pages inventory diffs by the current viewport", () => {
  const harness = createHarness(60, 8);
  press(harness.component, "i", "\r");
  assert.match(renderText(harness), /context line 1/);

  press(harness.component, "\u001b[6~");
  const secondPage = renderText(harness);
  assert.match(secondPage, /context line [2-6]/);
});

test("restores leading span padding when scrolling back to the first line", () => {
  const snapshot = makeSnapshot("snapshot-margin", [
    {
      path: "src/margin.ts",
      lines: [
        " head 1",
        " head 2",
        " head 3",
        ...Array.from({ length: 25 }, (_, index) => `+line ${index + 1}`),
      ],
    },
  ]);
  const delta = computeReviewDelta(snapshot);
  const routeCandidate: ReviewRouteCandidate = {
    snapshotId: snapshot.id,
    units: [
      {
        title: "Margin unit",
        whyHere: "Scrolling away and back exercises the scroll margin.",
        context: "margin",
        changeSummary: "Adds many lines below unchanged padding.",
        reviewFocus: [{ question: "Does the padding stay reachable?" }],
        spans: [span("src/margin.ts", { new: [4, 28] })],
      },
    ],
    skippedSpans: [],
  };
  const route = validateReviewRoute(snapshot, delta, routeCandidate);
  const harness = createHarness(60, 20, {
    snapshot,
    delta,
    routeCandidate,
    route,
  });

  assert.match(renderText(harness), /head 1/);

  press(harness.component, ...Array.from({ length: 15 }, () => "j"));
  const scrolled = renderText(harness);
  assert.doesNotMatch(scrolled, /head [1-3]/);

  press(harness.component, ...Array.from({ length: 15 }, () => "k"));
  const returned = renderText(harness);
  assert.match(returned, />\s+4 \+line 1\s/);
  assert.match(returned, /head 1/);
  assert.match(returned, /head 2/);
  assert.match(returned, /head 3/);
});

test("shows only the highlighted file name before and after its header pins", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([{ path: "src/sticky.ts", count: 30 }]),
    { theme: spanHeaderTheme },
  );
  const styledFileName = "\u001b[35m\u001b[1msrc/sticky.ts\u001b[22m\u001b[39m";

  const before = harness.component.render(60);
  const inlineHeader = before.find((line) => line.includes("src/sticky.ts"));
  assert.ok(inlineHeader);
  assert.ok(inlineHeader.includes(styledFileName));
  assert.doesNotMatch(inlineHeader, /\b(?:old|new)\b|"/);

  press(harness.component, ...Array.from({ length: 20 }, () => "j"));
  const after = harness.component.render(60);
  const pinnedHeader = after.find((line) => line.includes("src/sticky.ts"));
  assert.ok(pinnedHeader);
  assert.ok(pinnedHeader.includes(styledFileName));
  assert.doesNotMatch(pinnedHeader, /\b(?:old|new)\b|"/);
  assert.equal(
    after.filter((line) => line.includes("src/sticky.ts")).length,
    1,
  );
  assert.match(after.join("\n"), />\s+21 \+line 21/);
});

test("pins only the top span header in a unit that spans several files", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([
      { path: "src/a.ts", count: 20 },
      { path: "src/b.ts", count: 20 },
    ]),
  );

  press(harness.component, ...Array.from({ length: 20 }, () => "j"));
  const bridged = harness.component.render(60);
  const pinnedA = bridged.findIndex((line) => line.includes("src/a.ts"));
  const inlineB = bridged.findIndex((line) => line.includes("src/b.ts"));
  assert.ok(pinnedA >= 0);
  assert.ok(inlineB > pinnedA);

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const atHeader = harness.component.render(60);
  assert.equal(atHeader.filter((line) => line.includes("src/a.ts")).length, 0);
  assert.equal(atHeader.filter((line) => line.includes("src/b.ts")).length, 1);

  press(harness.component, ...Array.from({ length: 5 }, () => "j"));
  const deep = harness.component.render(60);
  assert.equal(deep.filter((line) => line.includes("src/b.ts")).length, 1);
});

test("pins the inventory file title while scrolling the read-only diff", () => {
  const harness = createHarness(
    60,
    12,
    makeTallFixture([{ path: "src/sticky.ts", count: 30 }]),
  );

  press(harness.component, "i", "\r");
  const top = harness.component.render(60);
  assert.equal(top.filter((line) => line.includes("planned:")).length, 1);

  press(harness.component, ...Array.from({ length: 6 }, () => "j"));
  const scrolled = harness.component.render(60);
  assert.match(scrolled[3] ?? "", /planned: "src\/sticky\.ts"/);
  assert.equal(scrolled.filter((line) => line.includes("planned:")).length, 1);

  press(harness.component, ...Array.from({ length: 40 }, () => "j"));
  const bottom = harness.component.render(60);
  assert.match(bottom[3] ?? "", /planned: "src\/sticky\.ts"/);
  assert.match(bottom.join("\n"), /\+line 30/);
});
