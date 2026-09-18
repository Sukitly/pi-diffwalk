import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarness,
  makeRoutineFixture,
  press,
  renderText,
} from "./harness.ts";

function progressOf(
  harness: ReturnType<typeof createHarness>,
  unitIndex: number,
) {
  const id = harness.state.review.route?.units[unitIndex]?.id;
  assert.ok(id);
  return harness.state.review.unitProgress.find((p) => p.reviewUnitId === id);
}

test("folds a routine unit: claim and reference shown, diff hidden, comments blocked", () => {
  const harness = createHarness(120, 30, makeRoutineFixture());
  press(harness.component, "l");
  const output = renderText(harness);

  assert.match(output, /Routine: User route registration/);
  assert.match(output, /Registers two user routes\./);
  assert.match(output, /Routine: Same route\(\) calls as the order routes/);
  assert.match(output, /Mirrors: src\/routes\/order\.ts:4-5/);
  assert.match(output, /2 changed lines folded\. Press o to expand/);
  assert.doesNotMatch(output, /userHandler|userByIdHandler/);
  assert.match(output.split("\n").at(-1) ?? "", /o expand.*n accept fold/);

  press(harness.component, "c");
  assert.match(
    renderText(harness),
    /Expand the routine unit with o before commenting/,
  );
  press(harness.component, "j", "G", "d");
  assert.doesNotMatch(renderText(harness), /userHandler/);
});

test("accepting a fold with n records glanced and counts it in the header", () => {
  const harness = createHarness(120, 30, makeRoutineFixture());
  press(harness.component, "l", "n");

  assert.equal(progressOf(harness, 1)?.disposition, "glanced");
  assert.equal(progressOf(harness, 1)?.expanded, undefined);
  const output = renderText(harness);
  assert.match(output, /Submission summary|Review incomplete/);
  assert.match(output, /1\/2 reviewed/);
  assert.match(output, /1 glanced/);
});

test("o expands a routine unit to the normal diff; completing it then is reviewed", () => {
  const harness = createHarness(120, 30, makeRoutineFixture());
  press(harness.component, "l", "o");
  let output = renderText(harness);

  assert.match(output, /userHandler/);
  assert.match(output, /userByIdHandler/);
  assert.doesNotMatch(output, /changed lines folded/);
  assert.equal(progressOf(harness, 1)?.expanded, true);
  assert.match(output.split("\n").at(-1) ?? "", /c comment/);

  press(harness.component, "o");
  output = renderText(harness);
  assert.match(output, /changed lines folded/);
  assert.equal(
    progressOf(harness, 1)?.expanded,
    true,
    "Folding again keeps the record.",
  );

  press(harness.component, "o", "n");
  assert.equal(progressOf(harness, 1)?.disposition, "reviewed");
  assert.doesNotMatch(renderText(harness), /glanced/);
});

test("comments are possible once expanded and the unit details show the claim", () => {
  const harness = createHarness(120, 30, makeRoutineFixture());
  press(harness.component, "l", "o", "c");
  assert.match(renderText(harness), /Review comment/);
  press(harness.component, "\u001b");

  press(harness.component, "e");
  const details = renderText(harness);
  assert.match(details, /Routine claim/);
  assert.match(details, /Mirrors src\/routes\/order\.ts:4-5\./);
});

test("r marks a walked unit as a routine candidate and refuses on routine units", () => {
  const harness = createHarness(120, 30, makeRoutineFixture());
  press(harness.component, "r");
  let output = renderText(harness);
  assert.match(output, /Marked as a routine candidate/);
  assert.match(output, /Token validation \(routine candidate\)/);
  assert.equal(progressOf(harness, 0)?.routineCandidate, true);

  press(harness.component, "r");
  output = renderText(harness);
  assert.match(output, /Cleared the routine candidate mark/);
  assert.equal(progressOf(harness, 0)?.routineCandidate, undefined);

  press(harness.component, "l", "r");
  assert.match(renderText(harness), /This unit is already routine/);
  press(harness.component, "h", "o");
  assert.match(
    renderText(harness),
    /This unit is not routine; there is nothing folded/,
  );
});

test("help lists the fold and candidate keys", () => {
  const harness = createHarness(120, 40, makeRoutineFixture());
  press(harness.component, "?");
  const output = renderText(harness);
  assert.match(output, /Expand or fold a routine unit/);
  assert.match(output, /could have been routine/);
});
