/**
 * What the interface is allowed to claim about a searched place.
 *
 * The failure mode of this feature is a confident answer about the wrong
 * junction. Geocoding Accra is uneven — tested against the live service,
 * "Ring Road Central" returns a bank branch and "Kwame Nkrumah Circle"
 * returns two positions two kilometres apart — so what matters most here is
 * what the badge REFUSES to say.
 *
 * DOM wiring is not covered, matching the rest of this codebase. The decision
 * that can do harm was pulled out as a pure function precisely so it could be
 * asserted against fixed inputs instead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlaceResult } from "./api.ts";
import { describeResult } from "./search.ts";

function place(overrides: Partial<PlaceResult> = {}): PlaceResult {
  return {
    title: "Kaneshie Market",
    longitude: -0.23666,
    latitude: 5.566,
    covered: true,
    ...overrides,
  };
}

/** Anything a glancing user could read as "this place is fine". */
const READS_AS_SAFE = /\bsafe\b|\bdry\b|no flooding|not flooded|\blow\b|no particular concern/i;

describe("a place with a live reading", () => {
  it("reports the level in the same words the legend uses", () => {
    const badge = describeResult(place({ level: "confirmed" }));
    assert.equal(badge.tone, "level");
    assert.equal(badge.level, "confirmed");
    assert.ok(badge.colour, "a level badge carries its colour");
    assert.ok(badge.text.length > 0);
  });

  it("carries a colour for every level it can report", () => {
    for (const level of ["low", "watch", "high", "confirmed"]) {
      const badge = describeResult(place({ level }));
      assert.equal(badge.tone, "level", `${level} should be a level badge`);
      assert.ok(badge.colour, `${level} should carry a colour`);
    }
  });
});

describe("a place the grid has never scored", () => {
  it("says it is outside coverage rather than giving a level", () => {
    const badge = describeResult(place({ covered: false }));
    assert.equal(badge.tone, "uncovered");
    assert.match(badge.text, /Outside the area/i);
  });

  it("never reads as an all-clear", () => {
    // The load-bearing assertion of this file. An absence of information must
    // not be presentable as good news: somebody searching for Tema and shown
    // anything resembling "low" has been told the opposite of the truth.
    const badge = describeResult(place({ covered: false }));
    assert.doesNotMatch(badge.text, READS_AS_SAFE);
    assert.equal(badge.colour, undefined, "an uncovered badge must not borrow the level palette");
    assert.equal(badge.level, undefined);
  });

  it("treats a covered place with no reading the same way", () => {
    // Possible at the very edge of an area, where the envelope includes ground
    // the grid stops short of. Still not an all-clear.
    const badge = describeResult(place({ covered: true, level: undefined }));
    assert.equal(badge.tone, "uncovered");
    assert.doesNotMatch(badge.text, READS_AS_SAFE);
    assert.equal(badge.colour, undefined);
  });
});
