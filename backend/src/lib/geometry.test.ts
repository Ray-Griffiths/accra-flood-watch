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
  mergeBounds,
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

/**
 * Coalescing the avoidance request.
 *
 * The invariant under test is "same ground, fewer rectangles". A merge that
 * quietly grew a box would close dry roads; one that dropped a cell would
 * hand the router a hazard it was never told about. Both are checked by
 * re-testing the original cells against the merged result.
 */
describe("mergeBounds", () => {
  /** A run of `count` cells eastward from `west` on one row. */
  function row(west: number, south: number, count: number): Bounds[] {
    const boxes: Bounds[] = [];
    for (let i = 0; i < count; i += 1) {
      boxes.push({
        west: west + i * 0.002,
        east: west + (i + 1) * 0.002,
        south,
        north: south + 0.002,
      });
    }
    return boxes;
  }

  it("leaves a single box alone", () => {
    assert.deepEqual(mergeBounds([BOX]), [BOX]);
  });

  it("joins a run of adjacent cells into one rectangle", () => {
    const merged = mergeBounds(row(-0.22, 5.57, 5));
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0], { west: -0.22, south: 5.57, east: -0.21, north: 5.572 });
  });

  it("joins stacked rows into a block", () => {
    const block = [...row(-0.22, 5.57, 4), ...row(-0.22, 5.572, 4), ...row(-0.22, 5.574, 4)];
    const merged = mergeBounds(block);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0], { west: -0.22, south: 5.57, east: -0.212, north: 5.576 });
  });

  it("keeps a gap in the run as a gap", () => {
    const split = [...row(-0.22, 5.57, 2), ...row(-0.21, 5.57, 2)];
    const merged = mergeBounds(split);
    assert.equal(merged.length, 2);
  });

  it("never reports a cell as merged away", () => {
    const scattered = [
      ...row(-0.22, 5.57, 3),
      ...row(-0.22, 5.572, 3),
      ...row(-0.2, 5.58, 1),
      ...row(-0.19, 5.59, 2),
    ];
    const merged = mergeBounds(scattered);

    // Every original cell centre must still fall inside something merged.
    for (const cell of scattered) {
      const centre: Position = [
        (cell.west + cell.east) / 2,
        (cell.south + cell.north) / 2,
      ];
      assert.ok(
        merged.some((box) => isInsideBox(centre, box)),
        `cell at ${centre.join(",")} was lost`,
      );
    }
  });

  it("does not grow over ground no cell covered", () => {
    // An L: three cells along a row, one stacked on the western end. The
    // merged result must not become the 3x2 rectangle that would swallow the
    // two empty cells in the corner.
    const shape = [...row(-0.22, 5.57, 3), ...row(-0.22, 5.572, 1)];
    const merged = mergeBounds(shape);

    const emptyCorner: Position = [-0.215, 5.573];
    assert.ok(!merged.some((box) => isInsideBox(emptyCorner, box)));
  });
});
