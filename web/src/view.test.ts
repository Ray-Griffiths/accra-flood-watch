/**
 * The view-selection rules.
 *
 * Two of these are safety rules rather than preferences: if they regress, the
 * map can show a user dry-weather ground while water is rising. That is worth
 * a test each, in both directions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RiskCell } from "./api.ts";
import { decideView, hasConfirmedCell } from "./view.ts";

function cell(level: string): RiskCell {
  return {
    cell: "ebzzdyp",
    bounds: { west: -0.24, south: 5.55, east: -0.239, north: 5.551 },
    score: 50,
    level,
    basis: "terrain-and-forecast",
    explanation: "",
    susceptibility: 50,
    hand: 1,
  };
}

describe("decideView: following the weather", () => {
  it("shows terrain when no rain is coming", () => {
    const decision = decideView({ outlook: "none", anyConfirmed: false, manual: null });
    assert.equal(decision.view, "terrain");
    assert.match(decision.reason, /No rain forecast/);
  });

  it("shows the live risk once any rain is coming", () => {
    assert.equal(
      decideView({ outlook: "light", anyConfirmed: false, manual: null }).view,
      "now",
    );
    assert.equal(
      decideView({ outlook: "significant", anyConfirmed: false, manual: null }).view,
      "now",
    );
  });

  /**
   * A feed that failed is not evidence of a dry day. Reading a missing number
   * as "no rain" and switching to the ground view would be inventing good
   * news at precisely the moment the system knows least.
   */
  it("keeps the live risk when the forecast feed is down", () => {
    assert.equal(decideView({ outlook: null, anyConfirmed: false, manual: null }).view, "now");
    assert.equal(
      decideView({ outlook: undefined, anyConfirmed: false, manual: null }).view,
      "now",
    );
  });
});

describe("decideView: the user's choice", () => {
  it("honours a manual switch to terrain on a dry day", () => {
    const decision = decideView({ outlook: "none", anyConfirmed: false, manual: "terrain" });
    assert.equal(decision.view, "terrain");
    assert.equal(decision.overrodeChoice, false);
  });

  it("honours a manual switch to terrain in light rain", () => {
    const decision = decideView({ outlook: "light", anyConfirmed: false, manual: "terrain" });
    assert.equal(decision.view, "terrain");
    assert.equal(decision.overrodeChoice, false);
  });

  it("honours a manual switch back to the live risk on a dry day", () => {
    const decision = decideView({ outlook: "none", anyConfirmed: false, manual: "now" });
    assert.equal(decision.view, "now");
    assert.equal(decision.overrodeChoice, false);
  });
});

describe("decideView: safety rules that outrank the user's choice", () => {
  it("forces the live risk when flooding is being reported", () => {
    const decision = decideView({ outlook: "none", anyConfirmed: true, manual: "terrain" });
    assert.equal(decision.view, "now");
    assert.equal(decision.overrodeChoice, true);
    assert.match(decision.reason, /reporting water/);
  });

  it("forces the live risk when flooding rain is forecast", () => {
    const decision = decideView({
      outlook: "significant",
      anyConfirmed: false,
      manual: "terrain",
    });
    assert.equal(decision.view, "now");
    assert.equal(decision.overrodeChoice, true);
    assert.match(decision.reason, /heavy enough to flood/);
  });

  it("reports a live report as an override even with no forecast at all", () => {
    const decision = decideView({ outlook: null, anyConfirmed: true, manual: "terrain" });
    assert.equal(decision.view, "now");
    assert.equal(decision.overrodeChoice, true);
  });

  /**
   * Nothing was overridden if the user was already looking at the live view.
   * Announcing an override that did not happen trains people to ignore the
   * announcement.
   */
  it("does not claim an override when the user was already on the live view", () => {
    for (const manual of ["now", null] as const) {
      assert.equal(
        decideView({ outlook: "significant", anyConfirmed: true, manual }).overrodeChoice,
        false,
      );
    }
  });

  it("always explains what is on screen", () => {
    const cases = [
      { outlook: "none", anyConfirmed: false, manual: null },
      { outlook: "light", anyConfirmed: false, manual: null },
      { outlook: "significant", anyConfirmed: false, manual: null },
      { outlook: null, anyConfirmed: false, manual: null },
      { outlook: "none", anyConfirmed: false, manual: "terrain" },
      { outlook: "none", anyConfirmed: true, manual: "terrain" },
    ] as const;

    for (const input of cases) {
      const { reason } = decideView(input);
      assert.ok(reason.length > 0, `empty reason for ${JSON.stringify(input)}`);
      assert.match(reason, /\.$/, `reason not a sentence for ${JSON.stringify(input)}`);
    }
  });
});

describe("hasConfirmedCell", () => {
  it("finds a confirmed cell anywhere in the viewport", () => {
    assert.equal(hasConfirmedCell([cell("low"), cell("high"), cell("confirmed")]), true);
  });

  it("is false when nothing is confirmed", () => {
    assert.equal(hasConfirmedCell([cell("low"), cell("watch"), cell("high")]), false);
    assert.equal(hasConfirmedCell([]), false);
  });
});
