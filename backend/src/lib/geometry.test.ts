/**
 * The intersection test that backs "never return a route through a confirmed
 * cell".
 *
 * The case that matters most is the one sampling gets wrong: a segment that
 * crosses a box without either endpoint being near it. If that regresses, a
 * route straight through standing water is returned as safe.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Bounds } from "./geohash.ts";
import {
  boundingBox,
  boxesOnPath,
  isInsideBox,
  pathIntersectsBox,
  segmentIntersectsBox,
  type Position,
} from "./geometry.ts";

/** A cell near the middle of the pilot area, roughly 152m square. */
const BOX: Bounds = { west: -0.22, south: 5.57, east: -0.218, north: 5.572 };

describe("isInsideBox", () => {
  it("accepts a point in the middle", () => {
    assert.equal(isInsideBox([-0.219, 5.571], BOX), true);
  });

  it("rejects a point outside on each side", () => {
    assert.equal(isInsideBox([-0.25, 5.571], BOX), false);
    assert.equal(isInsideBox([-0.21, 5.571], BOX), false);
    assert.equal(isInsideBox([-0.219, 5.55], BOX), false);
    assert.equal(isInsideBox([-0.219, 5.6], BOX), false);
  });

  it("counts the boundary as inside", () => {
    assert.equal(isInsideBox([BOX.west, BOX.south], BOX), true);
    assert.equal(isInsideBox([BOX.east, BOX.north], BOX), true);
  });
});

describe("segmentIntersectsBox", () => {
  /**
   * The reason this is not a sampling loop. Both endpoints are hundreds of
   * metres clear of the cell, and the line goes straight through it.
   */
  it("catches a segment that crosses with both ends far outside", () => {
    assert.equal(segmentIntersectsBox([-0.24, 5.571], [-0.2, 5.571], BOX), true);
  });

  it("catches a diagonal crossing", () => {
    assert.equal(segmentIntersectsBox([-0.24, 5.55], [-0.2, 5.59], BOX), true);
  });

  it("catches a segment that starts inside and leaves", () => {
    assert.equal(segmentIntersectsBox([-0.219, 5.571], [-0.2, 5.571], BOX), true);
  });

  it("catches a segment contained entirely within the box", () => {
    assert.equal(segmentIntersectsBox([-0.2195, 5.5705], [-0.2185, 5.5715], BOX), true);
  });

  it("rejects a segment that passes cleanly to one side", () => {
    assert.equal(segmentIntersectsBox([-0.24, 5.56], [-0.2, 5.56], BOX), false);
    assert.equal(segmentIntersectsBox([-0.24, 5.58], [-0.2, 5.58], BOX), false);
    assert.equal(segmentIntersectsBox([-0.23, 5.55], [-0.23, 5.59], BOX), false);
  });

  /**
   * A segment aimed at the box but stopping short must not count. Liang-Barsky
   * works on an infinite line, so the t range has to be held to [0, 1]; if it
   * is not, this is the test that fails.
   */
  it("rejects a segment that stops before reaching the box", () => {
    assert.equal(segmentIntersectsBox([-0.24, 5.571], [-0.23, 5.571], BOX), false);
  });

  it("rejects a segment that starts after the box", () => {
    assert.equal(segmentIntersectsBox([-0.21, 5.571], [-0.2, 5.571], BOX), false);
  });

  it("handles a zero-length segment", () => {
    assert.equal(segmentIntersectsBox([-0.219, 5.571], [-0.219, 5.571], BOX), true);
    assert.equal(segmentIntersectsBox([-0.24, 5.55], [-0.24, 5.55], BOX), false);
  });

  it("catches a segment that grazes the edge", () => {
    assert.equal(segmentIntersectsBox([-0.24, BOX.south], [-0.2, BOX.south], BOX), true);
  });
});

describe("pathIntersectsBox", () => {
  const clear: Position[] = [
    [-0.24, 5.56],
    [-0.23, 5.56],
    [-0.21, 5.56],
  ];

  it("is false for a path that stays clear", () => {
    assert.equal(pathIntersectsBox(clear, BOX), false);
  });

  /**
   * The middle segment is the only one that touches the cell. A check that
   * looked only at the first or last leg would pass this route.
   */
  it("is true when only an interior segment crosses", () => {
    const path: Position[] = [
      [-0.24, 5.56],
      [-0.24, 5.571],
      [-0.2, 5.571],
      [-0.2, 5.56],
    ];
    assert.equal(pathIntersectsBox(path, BOX), true);
  });

  it("handles a single-point path", () => {
    assert.equal(pathIntersectsBox([[-0.219, 5.571]], BOX), true);
    assert.equal(pathIntersectsBox([[-0.24, 5.56]], BOX), false);
  });

  it("is false for an empty path", () => {
    assert.equal(pathIntersectsBox([], BOX), false);
  });
});

describe("boxesOnPath", () => {
  it("returns only the boxes actually touched", () => {
    const boxes = [
      { cell: "a", bounds: BOX },
      { cell: "b", bounds: { west: -0.23, south: 5.56, east: -0.228, north: 5.562 } },
      { cell: "c", bounds: { west: -0.21, south: 5.58, east: -0.208, north: 5.582 } },
    ];
    const path: Position[] = [
      [-0.24, 5.571],
      [-0.2, 5.571],
    ];

    const hit = boxesOnPath(path, boxes);
    assert.deepEqual(
      hit.map((box) => box.cell),
      ["a"],
    );
  });
});

describe("boundingBox", () => {
  it("spans the points given", () => {
    const box = boundingBox([
      [-0.24, 5.56],
      [-0.2, 5.58],
    ]);
    assert.deepEqual(box, { west: -0.24, south: 5.56, east: -0.2, north: 5.58 });
  });

  it("grows by the padding on every side", () => {
    const box = boundingBox(
      [
        [-0.24, 5.56],
        [-0.2, 5.58],
      ],
      0.01,
    );
    assert.equal(box.west, -0.25);
    assert.equal(box.south, 5.55);
    assert.equal(Math.round(box.east * 1000) / 1000, -0.19);
    assert.equal(Math.round(box.north * 1000) / 1000, 5.59);
  });

  it("handles a single point", () => {
    const box = boundingBox([[-0.22, 5.57]], 0.001);
    assert.equal(Math.round(box.west * 10000) / 10000, -0.221);
    assert.equal(Math.round(box.east * 10000) / 10000, -0.219);
  });
});
