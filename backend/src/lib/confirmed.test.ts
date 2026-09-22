import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { explainConfirmed } from "./scoring.ts";

/**
 * The confirmed-cell sentence is now reached by two independent code paths:
 * the hourly scoring run, and the immediate alert fired when a report is what
 * tips a cell over. These tests pin the wording so the two cannot drift — a
 * person who gets the push and then opens the map must be handed one account
 * of the fact, not two.
 */
describe("explainConfirmed", () => {
  it("names the deepest water reported", () => {
    const sentence = explainConfirmed(3, "waist");
    assert.match(sentence, /waist deep/);
  });

  it("carries the number of independent reports", () => {
    assert.match(explainConfirmed(2, "knee"), /2 independent reports/);
    assert.match(explainConfirmed(7, "knee"), /7 independent reports/);
  });

  it("tells the reader what to do about it", () => {
    assert.match(explainConfirmed(2, "impassable"), /Avoid this area\./);
  });

  it("falls back to a neutral word when no depth is known", () => {
    const sentence = explainConfirmed(2, undefined);
    assert.match(sentence, /reporting water flooded right now/);
    assert.doesNotMatch(sentence, /undefined/);
  });

  it("treats a null depth the same as a missing one", () => {
    assert.equal(explainConfirmed(2, null), explainConfirmed(2, undefined));
  });

  it("speaks in the present tense about observation, not prediction", () => {
    // The distinction matters: this sentence is the one claim in the system
    // that is about what IS rather than what MIGHT BE.
    const sentence = explainConfirmed(2, "knee");
    assert.match(sentence, /right now/);
    assert.doesNotMatch(sentence, /forecast|likely|expected/i);
  });

  it("starts with a capital and ends with a full stop", () => {
    const sentence = explainConfirmed(2, "ankle");
    assert.match(sentence, /^[A-Z]/);
    assert.match(sentence, /\.$/);
  });
});
