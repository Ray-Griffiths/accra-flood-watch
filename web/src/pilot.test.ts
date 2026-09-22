import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areaContaining,
  envelopeOf,
  isInsideCoverage,
  type Bbox,
  type CoverageArea,
} from "./pilot.ts";

/** The live covered area: the Odaw basin, Korle Lagoon up to Achimota. */
const ODAW: CoverageArea = {
  id: "odaw",
  name: "Odaw basin: Korle Lagoon to Achimota",
  bbox: [-0.25, 5.535, -0.17, 5.65],
};
const COVERAGE: CoverageArea[] = [ODAW];

/** Two areas with a gap, to exercise the case a single box gets wrong. */
const WEST: CoverageArea = { id: "w", name: "West", bbox: [-0.3, 5.5, -0.28, 5.52] };
const EAST: CoverageArea = { id: "e", name: "East", bbox: [-0.2, 5.5, -0.18, 5.52] };

describe("isInsideCoverage", () => {
  it("accepts the centre of the covered area", () => {
    assert.equal(isInsideCoverage(COVERAGE, -0.21, 5.57), true);
  });

  it("accepts the upstream ground the old pilot box excluded", () => {
    // East Legon-ish used to be the canonical out-of-bounds example. Achimota
    // and Alajo were too, and both are now inside: extending to the catchment
    // is what this change was for.
    assert.equal(isInsideCoverage(COVERAGE, -0.187, 5.6037), true); // Achimota
    assert.equal(isInsideCoverage(COVERAGE, -0.2115, 5.582), true); // Alajo
  });

  it("rejects a position outside it", () => {
    assert.equal(isInsideCoverage(COVERAGE, -0.31, 5.55), false); // Weija
    assert.equal(isInsideCoverage(COVERAGE, 0.01, 5.63), false); // Tema
    assert.equal(isInsideCoverage(COVERAGE, -0.21, 5.7), false); // north of it
  });

  it("includes every edge", () => {
    const [west, south, east, north] = ODAW.bbox;
    assert.equal(isInsideCoverage(COVERAGE, west, south), true);
    assert.equal(isInsideCoverage(COVERAGE, east, north), true);
    assert.equal(isInsideCoverage(COVERAGE, west, north), true);
    assert.equal(isInsideCoverage(COVERAGE, east, south), true);
  });

  it("excludes a position just beyond each edge", () => {
    const [west, south, east, north] = ODAW.bbox;
    const nudge = 0.0001;
    assert.equal(isInsideCoverage(COVERAGE, west - nudge, 5.57), false);
    assert.equal(isInsideCoverage(COVERAGE, east + nudge, 5.57), false);
    assert.equal(isInsideCoverage(COVERAGE, -0.21, south - nudge), false);
    assert.equal(isInsideCoverage(COVERAGE, -0.21, north + nudge), false);
  });

  it("does not confuse the two axes", () => {
    // Longitude and latitude swapped. Both numbers are individually plausible
    // and the pair is nowhere near Accra, so a transposed call must fail.
    assert.equal(isInsideCoverage(COVERAGE, 5.57, -0.21), false);
  });

  it("rejects non-finite values rather than letting them through", () => {
    assert.equal(isInsideCoverage(COVERAGE, Number.NaN, 5.57), false);
    assert.equal(isInsideCoverage(COVERAGE, -0.21, Number.NaN), false);
    assert.equal(isInsideCoverage(COVERAGE, Number.POSITIVE_INFINITY, 5.57), false);
  });

  it("rejects everything when coverage is empty", () => {
    // A config that failed to deliver areas must not read as "everywhere is
    // fine"; it must read as "nowhere is covered".
    assert.equal(isInsideCoverage([], -0.21, 5.57), false);
  });

  it("treats the gap between two areas as outside", () => {
    const areas = [WEST, EAST];
    assert.equal(isInsideCoverage(areas, -0.29, 5.51), true);
    assert.equal(isInsideCoverage(areas, -0.19, 5.51), true);
    // Inside the envelope of the two, inside neither of them.
    assert.equal(isInsideCoverage(areas, -0.24, 5.51), false);
  });
});

describe("areaContaining", () => {
  it("names the area a position falls in", () => {
    assert.equal(areaContaining(COVERAGE, -0.21, 5.57)?.id, "odaw");
  });

  it("picks the right one of several", () => {
    assert.equal(areaContaining([WEST, EAST], -0.19, 5.51)?.id, "e");
  });

  it("returns null outside every area", () => {
    assert.equal(areaContaining([WEST, EAST], -0.24, 5.51), null);
  });
});

describe("envelopeOf", () => {
  it("returns the single area unchanged", () => {
    assert.deepEqual(envelopeOf(COVERAGE), ODAW.bbox);
  });

  it("spans several areas", () => {
    assert.deepEqual(envelopeOf([WEST, EAST]), [-0.3, 5.5, -0.18, 5.52] as Bbox);
  });

  it("returns null when there is nothing to frame", () => {
    assert.equal(envelopeOf([]), null);
  });
});
