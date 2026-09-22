import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInsidePilotArea, type Bbox } from "./pilot.ts";

/** The live pilot area: Circle, Kaneshie and Avenor. */
const PILOT: Bbox = [-0.245, 5.55, -0.195, 5.59];

describe("isInsidePilotArea", () => {
  it("accepts the centre of the pilot area", () => {
    assert.equal(isInsidePilotArea(PILOT, -0.22, 5.57), true);
  });

  it("rejects a position outside it", () => {
    // East Legon-ish: a real place in Accra, outside the covered box. This is
    // the case that was turning every report into a 422 and every route into
    // a 400, because the browser sent the device fix without checking.
    assert.equal(isInsidePilotArea(PILOT, -0.185, 5.6), false);
  });

  it("includes every edge", () => {
    const [west, south, east, north] = PILOT;
    assert.equal(isInsidePilotArea(PILOT, west, south), true);
    assert.equal(isInsidePilotArea(PILOT, east, north), true);
    assert.equal(isInsidePilotArea(PILOT, west, north), true);
    assert.equal(isInsidePilotArea(PILOT, east, south), true);
  });

  it("excludes a position just beyond each edge", () => {
    const [west, south, east, north] = PILOT;
    const nudge = 0.0001;
    assert.equal(isInsidePilotArea(PILOT, west - nudge, 5.57), false);
    assert.equal(isInsidePilotArea(PILOT, east + nudge, 5.57), false);
    assert.equal(isInsidePilotArea(PILOT, -0.22, south - nudge), false);
    assert.equal(isInsidePilotArea(PILOT, -0.22, north + nudge), false);
  });

  it("does not confuse the two axes", () => {
    // Longitude and latitude swapped. Both numbers are individually plausible
    // and the pair is nowhere near Accra, so a transposed call must fail.
    assert.equal(isInsidePilotArea(PILOT, 5.57, -0.22), false);
  });

  it("rejects non-finite values rather than letting them through", () => {
    assert.equal(isInsidePilotArea(PILOT, Number.NaN, 5.57), false);
    assert.equal(isInsidePilotArea(PILOT, -0.22, Number.NaN), false);
    assert.equal(isInsidePilotArea(PILOT, Number.POSITIVE_INFINITY, 5.57), false);
  });
});
