import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bounds, cellSize, cellsCovering, encode, neighbours } from "./geohash.ts";
import {
  cellFor,
  clipToPilotArea,
  isInsidePilotArea,
  parseBbox,
  prefixesForViewport,
  prefixOfCell,
  PILOT_BBOX,
  PREFIX_PRECISION,
} from "./pilot.ts";

describe("geohash encode", () => {
  it("matches the canonical reference vector", () => {
    // Same assertion as preprocessing/test_geohashing.py. If these two ever
    // disagree, reports get written into cells the grid does not contain.
    assert.equal(encode(57.64911, 10.40744, 11), "u4pruydqqvj");
  });

  it("matches the Python implementation for Accra landmarks", () => {
    // Values produced by preprocessing/geohashing.py and verified against the
    // seeded DynamoDB grid.
    assert.equal(encode(5.5709, -0.2074, 7), "ebzzeq0");
    assert.equal(encode(5.5709, -0.2074, 6), "ebzzeq");
  });

  it("respects precision", () => {
    for (let precision = 1; precision <= 11; precision += 1) {
      assert.equal(encode(5.5709, -0.2074, precision).length, precision);
    }
  });

  it("produces prefixes that nest", () => {
    const full = encode(5.5709, -0.2074, 9);
    for (let precision = 1; precision <= 9; precision += 1) {
      assert.ok(full.startsWith(encode(5.5709, -0.2074, precision)));
    }
  });
});

describe("geohash bounds", () => {
  it("contains the encoded point", () => {
    const box = bounds(encode(5.5709, -0.2074, 7));
    assert.ok(box.west <= -0.2074 && -0.2074 <= box.east);
    assert.ok(box.south <= 5.5709 && 5.5709 <= box.north);
  });

  it("round trips from the cell centre", () => {
    const cell = encode(5.5709, -0.2074, 7);
    const box = bounds(cell);
    assert.equal(
      encode((box.south + box.north) / 2, (box.west + box.east) / 2, 7),
      cell,
    );
  });

  it("rejects invalid characters", () => {
    assert.throws(() => bounds("ebzzea!"));
  });
});

describe("cell size", () => {
  it("is about 150 metres at precision 7", () => {
    const { width, height } = cellSize(7);
    assert.ok(width * 111_320 * 0.99528 > 140);
    assert.ok(width * 111_320 * 0.99528 < 165);
    assert.ok(height * 110_574 > 140);
    assert.ok(height * 110_574 < 165);
  });
});

describe("cellsCovering", () => {
  it("covers the pilot area with a workable cell count", () => {
    const cells = cellsCovering(PILOT_BBOX, 7);
    // preprocessing produced 1,140 cells for this bbox.
    assert.equal(cells.length, 1140);
  });

  it("returns only cells that intersect the box", () => {
    for (const cell of cellsCovering(PILOT_BBOX, 7)) {
      const box = bounds(cell);
      assert.ok(box.east > PILOT_BBOX.west && box.west < PILOT_BBOX.east);
      assert.ok(box.north > PILOT_BBOX.south && box.south < PILOT_BBOX.north);
    }
  });

  it("includes the corners and centre of the box", () => {
    const cells = new Set(cellsCovering(PILOT_BBOX, 7));
    const nudge = 1e-4;
    const probes: Array<[number, number]> = [
      [PILOT_BBOX.south + nudge, PILOT_BBOX.west + nudge],
      [PILOT_BBOX.south + nudge, PILOT_BBOX.east - nudge],
      [PILOT_BBOX.north - nudge, PILOT_BBOX.west + nudge],
      [PILOT_BBOX.north - nudge, PILOT_BBOX.east - nudge],
      [
        (PILOT_BBOX.south + PILOT_BBOX.north) / 2,
        (PILOT_BBOX.west + PILOT_BBOX.east) / 2,
      ],
    ];
    for (const [latitude, longitude] of probes) {
      assert.ok(cells.has(encode(latitude, longitude, 7)));
    }
  });
});

describe("neighbours", () => {
  it("returns eight distinct surrounding cells", () => {
    const cell = encode(5.5709, -0.2074, 7);
    const result = neighbours(cell);
    assert.equal(result.length, 8);
    assert.equal(new Set(result).size, 8);
    assert.ok(!result.includes(cell));
  });

  it("is symmetric", () => {
    const cell = encode(5.5709, -0.2074, 7);
    for (const neighbour of neighbours(cell)) {
      assert.ok(neighbours(neighbour).includes(cell));
    }
  });
});

describe("pilot area", () => {
  it("accepts points inside", () => {
    assert.ok(isInsidePilotArea(5.5709, -0.2074)); // Kwame Nkrumah Circle
    assert.ok(isInsidePilotArea(5.5622, -0.2334)); // Kaneshie market
  });

  it("rejects points outside", () => {
    assert.ok(!isInsidePilotArea(5.6037, -0.187)); // Achimota
    assert.ok(!isInsidePilotArea(5.556, -0.19)); // just east of the boundary
    assert.ok(!isInsidePilotArea(6.6885, -1.6244)); // Kumasi
  });

  it("treats the boundary as inside", () => {
    assert.ok(isInsidePilotArea(PILOT_BBOX.south, PILOT_BBOX.west));
    assert.ok(isInsidePilotArea(PILOT_BBOX.north, PILOT_BBOX.east));
  });

  it("derives the prefix from a cell consistently", () => {
    const cell = cellFor(5.5709, -0.2074);
    assert.equal(prefixOfCell(cell), encode(5.5709, -0.2074, PREFIX_PRECISION));
    assert.equal(prefixOfCell(cell).length, PREFIX_PRECISION);
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

describe("viewport clipping", () => {
  it("clips a viewport wider than the pilot area", () => {
    const clipped = clipToPilotArea({
      west: -1,
      south: 5,
      east: 1,
      north: 6,
    });
    assert.deepEqual(clipped, PILOT_BBOX);
  });

  it("returns null for a viewport entirely outside", () => {
    assert.equal(
      clipToPilotArea({ west: 0.1, south: 5.55, east: 0.2, north: 5.58 }),
      null,
    );
    assert.equal(
      clipToPilotArea({ west: -0.24, south: 6.0, east: -0.2, north: 6.1 }),
      null,
    );
  });

  it("resolves a small viewport to a handful of prefixes", () => {
    // ~1km box around Kwame Nkrumah Circle.
    const prefixes = prefixesForViewport({
      west: -0.212,
      south: 5.566,
      east: -0.202,
      north: 5.576,
    });
    assert.ok(prefixes.length > 0);
    assert.ok(
      prefixes.length <= 6,
      `expected a handful of prefixes, got ${prefixes.length}`,
    );
    for (const prefix of prefixes) {
      assert.equal(prefix.length, PREFIX_PRECISION);
    }
  });

  it("returns no prefixes for a viewport outside the pilot area", () => {
    assert.deepEqual(
      prefixesForViewport({ west: 0.1, south: 5.55, east: 0.2, north: 5.58 }),
      [],
    );
  });

  it("covers the whole pilot area without exceeding the cap", () => {
    const prefixes = prefixesForViewport(PILOT_BBOX);
    assert.ok(prefixes.length > 0);
    assert.ok(prefixes.length <= 64);
    // Every grid cell must belong to one of the returned prefixes, or the map
    // would silently omit part of the overlay.
    const prefixSet = new Set(prefixes);
    for (const cell of cellsCovering(PILOT_BBOX, 7)) {
      assert.ok(prefixSet.has(prefixOfCell(cell)), `missing prefix for ${cell}`);
    }
  });
});
