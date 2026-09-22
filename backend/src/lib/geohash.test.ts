import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bounds, cellSize, cellsCovering, encode, neighbours } from "./geohash.ts";

/**
 * The original Circle / Kaneshie / Avenor pilot box, kept here as a fixed
 * fixture rather than imported from the coverage configuration.
 *
 * The cell count below was produced by `preprocessing/build_susceptibility.py`
 * for exactly this box, and it is what pins the TypeScript encoder to the
 * Python one. Pointing it at whatever coverage happens to be today would turn
 * a real cross-implementation check into a number that gets updated whenever
 * it disagrees.
 */
const PILOT_BBOX = { west: -0.245, south: 5.55, east: -0.195, north: 5.59 };

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
