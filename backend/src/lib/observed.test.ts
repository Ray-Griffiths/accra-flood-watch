/**
 * The observation-time rule on an incoming report.
 *
 * A report held on a phone while it had no signal arrives late and carries
 * when the water was SEEN. Accepting that without bounds would let a stale
 * observation confirm a cell that has since drained; refusing it outright
 * would lose exactly the reports made where the signal is worst. The window is
 * the compromise, and its edges are what this file pins down — against the
 * real function, not a restatement of it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOCK_SKEW_MINUTES,
  MAX_OBSERVATION_AGE_MINUTES,
  resolveObservedAt,
} from "./observed.ts";

const NOW = new Date("2026-09-22T12:00:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** A refusal is a string; an accepted observation is a Date. */
function refused(value: Date | string): boolean {
  return typeof value === "string";
}

describe("resolveObservedAt", () => {
  it("defaults to now for an ordinary online report", () => {
    assert.equal(resolveObservedAt(undefined, NOW), NOW);
    assert.equal(resolveObservedAt(null, NOW), NOW);
  });

  it("keeps a recent observation as given", () => {
    const observed = resolveObservedAt(minutesBefore(10), NOW);
    assert.ok(observed instanceof Date);
    assert.equal(observed.toISOString(), minutesBefore(10));
  });

  it("accepts the oldest observation still inside the window", () => {
    const edge = resolveObservedAt(minutesBefore(MAX_OBSERVATION_AGE_MINUTES), NOW);
    assert.ok(!refused(edge), "the boundary itself must be accepted");
  });

  it("refuses one minute past the window, and says why", () => {
    const past = resolveObservedAt(minutesBefore(MAX_OBSERVATION_AGE_MINUTES + 1), NOW);
    assert.ok(refused(past));
    assert.match(past as string, /half an hour old/);
  });

  it("tolerates a slightly fast clock by treating it as now", () => {
    // A phone a minute ahead is common and harmless. Writing its timestamp
    // verbatim would put a report in the future, which every age calculation
    // downstream would read as nonsense.
    assert.equal(resolveObservedAt(minutesBefore(-1), NOW), NOW);
  });

  it("refuses a clock far enough ahead to be wrong", () => {
    const ahead = resolveObservedAt(minutesBefore(-CLOCK_SKEW_MINUTES - 1), NOW);
    assert.ok(refused(ahead));
    assert.match(ahead as string, /device clock/);
  });

  it("refuses anything that is not a parseable timestamp", () => {
    for (const bad of ["yesterday", "", 1_700_000_000, {}, []]) {
      assert.ok(refused(resolveObservedAt(bad, NOW)), `accepted ${JSON.stringify(bad)}`);
    }
  });
});
