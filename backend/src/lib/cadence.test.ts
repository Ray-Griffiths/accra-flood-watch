/**
 * When the scoring job decides to run.
 *
 * Two failure directions, and they are not symmetric. Running too often costs
 * fractions of a cent. Running too rarely means somebody is not told about
 * water. Every ambiguous case below is therefore asserted to resolve towards
 * running.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_INTERVAL_MINUTES,
  RAIN_INTERVAL_MINUTES,
  decideCadence,
} from "./cadence.ts";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("a dry day", () => {
  it("skips the ticks between hourly runs", () => {
    for (const elapsed of [15, 30, 45]) {
      const decision = decideCadence({
        now: NOW,
        lastRanAt: minutesAgo(elapsed),
        lastOutlook: "none",
      });
      assert.equal(decision.rescore, false, `should skip at ${elapsed} minutes`);
    }
  });

  it("still runs once the hourly floor is reached", () => {
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(MAX_INTERVAL_MINUTES),
      lastOutlook: "none",
    });
    assert.equal(decision.rescore, true);
  });

  it("treats light rain as dry for cadence purposes", () => {
    // Drizzle does not move a score enough to be worth four times the writes.
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(20),
      lastOutlook: "light",
    });
    assert.equal(decision.rescore, false);
  });
});

describe("rain", () => {
  it("rescores on the next tick", () => {
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(RAIN_INTERVAL_MINUTES),
      lastOutlook: "significant",
    });
    assert.equal(decision.rescore, true);
    assert.match(decision.reason, /rain/i);
  });

  it("does not rescore twice inside one tick", () => {
    // Guards against a duplicate schedule delivery turning into two full runs.
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(2),
      lastOutlook: "significant",
    });
    assert.equal(decision.rescore, false);
  });
});

describe("cases that must resolve towards running", () => {
  it("runs when there is no previous run at all", () => {
    assert.equal(
      decideCadence({ now: NOW, lastRanAt: null, lastOutlook: "none" }).rescore,
      true,
    );
  });

  it("runs when the previous timestamp is unreadable", () => {
    assert.equal(
      decideCadence({ now: NOW, lastRanAt: "not a date", lastOutlook: "none" }).rescore,
      true,
    );
  });

  it("runs when the previous run appears to be in the future", () => {
    const decision = decideCadence({
      now: NOW,
      lastRanAt: new Date(NOW.getTime() + 60_000).toISOString(),
      lastOutlook: "none",
    });
    assert.equal(decision.rescore, true);
  });

  it("treats a missing forecast as wet, not as dry", () => {
    // The load-bearing one. A failed feed is not evidence of a dry afternoon,
    // and slowing down on a missing number is the same mistake as painting
    // the map green on one.
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(RAIN_INTERVAL_MINUTES),
      lastOutlook: null,
    });
    assert.equal(decision.rescore, true);
    assert.match(decision.reason, /no forecast/i);
  });
});

describe("the reason", () => {
  it("explains a skip, so a quiet log reads as quiet on purpose", () => {
    const decision = decideCadence({
      now: NOW,
      lastRanAt: minutesAgo(30),
      lastOutlook: "none",
    });
    assert.equal(decision.rescore, false);
    assert.match(decision.reason, /dry/i);
    assert.match(decision.reason, /30/);
  });
});
