import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarness,
  makeModelSkipFixture,
  makeSkippedUnitFixture,
  press,
  renderText,
} from "./harness.ts";

test("a skipped unit never reaches the walkthrough", () => {
  const fixture = makeSkippedUnitFixture();
  assert.equal(fixture.route.units.length, 1);
  assert.equal(fixture.route.skippedUnits.length, 1);

  const harness = createHarness(120, 30, fixture);
  const output = renderText(harness);

  assert.match(output, /Token validation/);
  assert.match(output, /Unit 1\/1/);
  assert.doesNotMatch(output, /User route registration/);
  assert.doesNotMatch(output, /userHandler|userByIdHandler/);

  press(harness.component, "l");
  assert.doesNotMatch(renderText(harness), /User route registration/);
});

test("completing the only unit opens the summary, which reports the skipped unit", () => {
  const harness = createHarness(120, 40, makeSkippedUnitFixture());
  press(harness.component, "n");
  const output = renderText(harness);

  assert.match(output, /Units skipped before the walkthrough/);
  assert.match(
    output,
    /User route registration \(2 changed lines, agent claim\)/,
  );
  assert.match(output, /Same route\(\) calls as the order routes/);
  assert.match(output, /--no-skip/);
  assert.doesNotMatch(output, /userHandler/);
});

test("a decision model skip names the model and its reason in the summary", () => {
  const harness = createHarness(120, 40, makeModelSkipFixture());
  press(harness.component, "n");
  const output = renderText(harness);

  assert.match(
    output,
    /User route registration \(2 changed lines, decision model\)/,
  );
  assert.match(output, /Config change, no boundary\./);
});

test("the skipped unit's lines are covered as skipped, not left uncovered", () => {
  const fixture = makeSkippedUnitFixture();
  const reasons = fixture.route.skippedSpans.map((skip) => skip.reason);

  assert.equal(fixture.route.skippedSpans.length, 1);
  assert.match(reasons[0] ?? "", /^User route registration: /);
  assert.equal(fixture.route.skippedUnits[0]?.changedLineCount, 2);
});

test("help no longer offers fold or candidate keys", () => {
  const harness = createHarness(120, 40, makeSkippedUnitFixture());
  press(harness.component, "?");
  const output = renderText(harness);

  assert.doesNotMatch(output, /expand/i);
  assert.doesNotMatch(output, /routine/i);
});
