import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cellsCovering, encode } from "./geohash.ts";
import {
  COVERAGE_ENVELOPE,
  COVERED_AREAS,
  MAX_CORRIDOR_PREFIXES,
  MAX_PREFIXES_PER_REQUEST,
  PREFIX_PRECISION,
  areaContaining,
  cellFor,
  clipToCoverage,
  coveragePrefixes,
  describeCoverage,
  isInsideCoverage,
  parseBbox,
  prefixOfCell,
  prefixesForCorridor,
  prefixesForViewport,
  type CoveredArea,
} from "./pilot.ts";

/**
 * Two areas with a gap between them, and a third overlapping the first.
 *
 * Production runs a single contiguous area today, so without these the
 * disjoint and overlapping paths would ship untested -- and those are exactly
 * the paths that decide whether a gap in coverage reads as a gap or as ground
 * with nothing wrong with it.
 */
const WEST_AREA: CoveredArea = {
  id: "west",
  name: "West block",
  bounds: { west: -0.3, south: 5.5, east: -0.28, north: 5.52 },
};
const EAST_AREA: CoveredArea = {
  id: "east",
  name: "East block",
  bounds: { west: -0.2, south: 5.5, east: -0.18, north: 5.52 },
};
/** Deliberately overlaps WEST_AREA on its eastern half. */
const OVERLAP_AREA: CoveredArea = {
  id: "overlap",
  name: "Overlapping block",
  bounds: { west: -0.29, south: 5.5, east: -0.27, north: 5.52 },
};

describe("coverage membership", () => {
  it("accepts places inside the Odaw block", () => {
    assert.ok(isInsideCoverage(5.5709, -0.2074)); // Kwame Nkrumah Circle
    assert.ok(isInsideCoverage(5.5622, -0.2334)); // Kaneshie market
    assert.ok(isInsideCoverage(5.5765, -0.2185)); // Avenor junction
    assert.ok(isInsideCoverage(5.545, -0.222)); // Agbogbloshie / Korle Lagoon
  });

  it("now accepts the upstream ground the pilot box excluded", () => {
    // The whole point of extending to the catchment: Achimota is where the
    // water that floods Circle comes from, and the pilot box stopped short
    // of it.
    assert.ok(isInsideCoverage(5.6037, -0.187)); // Achimota
    assert.ok(isInsideCoverage(5.582, -0.2115)); // Alajo bridge approach
  });

  it("rejects places outside", () => {
    assert.ok(!isInsideCoverage(5.63, 0.01)); // Tema, east of the block
    assert.ok(!isInsideCoverage(5.55, -0.31)); // Weija, west of the block
    assert.ok(!isInsideCoverage(6.6885, -1.6244)); // Kumasi
    assert.ok(!isInsideCoverage(5.7, -0.21)); // north of the headwaters
  });

  it("treats the boundary itself as inside", () => {
    const { west, south, east, north } = COVERAGE_ENVELOPE;
    assert.ok(isInsideCoverage(south, west));
    assert.ok(isInsideCoverage(north, east));
  });

  it("rejects non-finite coordinates rather than throwing", () => {
    assert.equal(areaContaining(Number.NaN, -0.2), null);
    assert.equal(areaContaining(5.57, Number.POSITIVE_INFINITY), null);
  });

  it("names which area a point fell in", () => {
    const area = areaContaining(5.5709, -0.2074);
    assert.equal(area?.id, "odaw");
  });

  it("reports a point in the gap between disjoint areas as uncovered", () => {
    const areas = [WEST_AREA, EAST_AREA];
    assert.ok(isInsideCoverage(5.51, -0.29, areas)); // in the west block
    assert.ok(isInsideCoverage(5.51, -0.19, areas)); // in the east block
    // Between the two. Inside the envelope, outside coverage -- the case a
    // bounding-box check would get wrong.
    assert.ok(!isInsideCoverage(5.51, -0.24, areas));
  });
});

describe("describeCoverage", () => {
  it("names the single production area", () => {
    assert.equal(describeCoverage(), COVERED_AREAS[0]!.name);
  });

  it("joins several areas readably", () => {
    assert.equal(
      describeCoverage([WEST_AREA, EAST_AREA, OVERLAP_AREA]),
      "West block, East block and Overlapping block",
    );
  });

  it("does not claim coverage it does not have", () => {
    assert.equal(describeCoverage([]), "the covered area");
  });
});

describe("clipToCoverage", () => {
  it("clips a viewport wider than coverage back to the area", () => {
    const clipped = clipToCoverage({ west: -1, south: 5, east: 1, north: 6 });
    assert.equal(clipped.length, 1);
    assert.deepEqual(clipped[0], COVERED_AREAS[0]!.bounds);
  });

  it("returns nothing for a viewport entirely outside", () => {
    assert.deepEqual(clipToCoverage({ west: 0.1, south: 5.55, east: 0.2, north: 5.58 }), []);
    assert.deepEqual(clipToCoverage({ west: -0.24, south: 6.0, east: -0.2, north: 6.1 }), []);
  });

  it("returns one box per area a viewport straddles, and none for the gap", () => {
    const clipped = clipToCoverage(
      { west: -0.35, south: 5.49, east: -0.15, north: 5.53 },
      [WEST_AREA, EAST_AREA],
    );
    assert.equal(clipped.length, 2);
    // The gap between -0.28 and -0.2 contributes no box at all.
    for (const box of clipped) {
      assert.ok(box.east <= -0.28 || box.west >= -0.2);
    }
  });
});

describe("prefixesForViewport", () => {
  it("resolves a small viewport to a handful of prefixes", () => {
    // ~1km box around Kwame Nkrumah Circle.
    const { prefixes, truncated } = prefixesForViewport({
      west: -0.212,
      south: 5.566,
      east: -0.202,
      north: 5.576,
    });
    assert.ok(prefixes.length > 0);
    assert.ok(prefixes.length <= 6, `expected a handful, got ${prefixes.length}`);
    assert.equal(truncated, false);
    for (const prefix of prefixes) {
      assert.equal(prefix.length, PREFIX_PRECISION);
    }
  });

  it("returns nothing for a viewport outside coverage", () => {
    const { prefixes, truncated } = prefixesForViewport({
      west: 0.1,
      south: 5.55,
      east: 0.2,
      north: 5.58,
    });
    assert.deepEqual(prefixes, []);
    assert.equal(truncated, false);
  });

  it("says so when a viewport needs more prefixes than it returns", () => {
    // The whole catchment at once exceeds the per-request cap. That is the
    // designed behaviour -- the client requests its viewport, not the world --
    // but it must be visible rather than silent, or the map goes blank in a
    // corner with nothing to distinguish that from low risk.
    const { prefixes, truncated } = prefixesForViewport(COVERAGE_ENVELOPE);
    assert.equal(prefixes.length, MAX_PREFIXES_PER_REQUEST);
    assert.equal(truncated, true);
  });

  it("does not return a prefix twice when areas overlap", () => {
    const { prefixes } = prefixesForViewport(
      { west: -0.31, south: 5.49, east: -0.26, north: 5.53 },
      [WEST_AREA, OVERLAP_AREA],
    );
    assert.equal(new Set(prefixes).size, prefixes.length);
  });

  it("returns prefixes in a stable order", () => {
    const box = { west: -0.212, south: 5.566, east: -0.202, north: 5.576 };
    assert.deepEqual(prefixesForViewport(box).prefixes, prefixesForViewport(box).prefixes);
    assert.deepEqual(
      prefixesForViewport(box).prefixes,
      [...prefixesForViewport(box).prefixes].sort(),
    );
  });
});

describe("coveragePrefixes", () => {
  it("covers every grid cell in every area", () => {
    // The hourly scoring job reads these. A cell whose prefix is missing is a
    // cell that is never rescored and quietly goes stale on the map.
    const prefixes = new Set(coveragePrefixes());
    for (const area of COVERED_AREAS) {
      for (const cell of cellsCovering(area.bounds, 7)) {
        assert.ok(prefixes.has(prefixOfCell(cell)), `missing prefix for ${cell}`);
      }
    }
  });

  it("is not capped the way a viewport is", () => {
    // The scoring job must see the whole grid; truncating here would leave
    // part of the city permanently unscored.
    assert.ok(coveragePrefixes().length > MAX_PREFIXES_PER_REQUEST);
  });

  it("deduplicates across overlapping areas", () => {
    const prefixes = coveragePrefixes([WEST_AREA, OVERLAP_AREA]);
    assert.equal(new Set(prefixes).size, prefixes.length);
  });
});

describe("prefixesForCorridor", () => {
  it("returns every prefix in a corridor, uncapped", () => {
    // A route is only as safe as the least-inspected stretch of it, so this
    // must not page. The whole catchment is well inside the sanity bound.
    const prefixes = prefixesForCorridor(COVERAGE_ENVELOPE);
    assert.notEqual(prefixes, null);
    assert.ok(prefixes!.length > MAX_PREFIXES_PER_REQUEST);
    assert.ok(prefixes!.length <= MAX_CORRIDOR_PREFIXES);
  });

  it("refuses rather than truncating when a corridor is too large to verify", () => {
    const huge: CoveredArea = {
      id: "huge",
      name: "Implausibly large area",
      bounds: { west: -1, south: 5, east: 1, north: 7 },
    };
    assert.equal(prefixesForCorridor(huge.bounds, [huge]), null);
  });

  it("returns nothing for a corridor outside coverage", () => {
    assert.deepEqual(prefixesForCorridor({ west: 1, south: 5, east: 1.1, north: 5.1 }), []);
  });
});

describe("cell and prefix derivation", () => {
  it("derives the prefix from a cell consistently", () => {
    const cell = cellFor(5.5709, -0.2074);
    assert.equal(prefixOfCell(cell), encode(5.5709, -0.2074, PREFIX_PRECISION));
    assert.equal(prefixOfCell(cell).length, PREFIX_PRECISION);
  });
});

describe("coverage envelope", () => {
  it("contains every area", () => {
    for (const area of COVERED_AREAS) {
      assert.ok(area.bounds.west >= COVERAGE_ENVELOPE.west);
      assert.ok(area.bounds.south >= COVERAGE_ENVELOPE.south);
      assert.ok(area.bounds.east <= COVERAGE_ENVELOPE.east);
      assert.ok(area.bounds.north <= COVERAGE_ENVELOPE.north);
    }
  });

  it("is not a substitute for a coverage check", () => {
    // Guards the reason the envelope is kept separate: with disjoint areas a
    // point can sit inside the envelope and outside every area.
    const areas = [WEST_AREA, EAST_AREA];
    const inTheGap = { latitude: 5.51, longitude: -0.24 };
    assert.ok(inTheGap.longitude > WEST_AREA.bounds.east);
    assert.ok(inTheGap.longitude < EAST_AREA.bounds.west);
    assert.ok(!isInsideCoverage(inTheGap.latitude, inTheGap.longitude, areas));
  });
});

describe("parseBbox", () => {
  it("parses a well-formed bbox", () => {
    assert.deepEqual(parseBbox("-0.24,5.55,-0.20,5.58"), {
      west: -0.24,
      south: 5.55,
      east: -0.2,
      north: 5.58,
    });
  });

  it("rejects malformed input", () => {
    for (const raw of [
      undefined,
      "",
      "1,2,3",
      "1,2,3,4,5",
      "a,b,c,d",
      "0,0,0,0", // zero area
      "1,1,0,2", // west past east
      "0,2,1,1", // south past north
      "-200,5,0,6", // longitude out of range
      "-1,-95,0,6", // latitude out of range
    ]) {
      assert.equal(parseBbox(raw), null, `expected null for ${String(raw)}`);
    }
  });
});
