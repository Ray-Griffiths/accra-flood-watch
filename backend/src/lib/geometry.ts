/**
 * Does a route pass through a box?
 *
 * This exists because `Avoid.Areas` is documented as best-effort: the router
 * "will try to honor the avoidance preferences but may still include
 * restricted areas if no feasible alternative route exists". For avoiding toll
 * roads that is a reasonable default. For avoiding water that people are
 * standing in, it is not — the whole promise of the feature is that a returned
 * route does not go through a flooded cell, and a promise kept only when
 * convenient is not a promise.
 *
 * So the returned geometry is checked here against the cells that were meant
 * to be avoided, and a route that violates a hard block is discarded rather
 * than shown. The router's own violation notice is read too, but this is the
 * guarantee: it does not depend on the service telling us it failed.
 *
 * Degrees are treated as a flat plane. Over a 5km pilot area at 5.5°N the
 * error is far below the 152m cell size, and both the route and the cells are
 * in the same coordinate system, so the comparison is consistent either way.
 */

import type { Bounds } from "./geohash.ts";

/** A [longitude, latitude] pair, matching GeoJSON and the GeoRoutes API. */
export type Position = readonly [number, number];

export function isInsideBox(point: Position, box: Bounds): boolean {
  const [lon, lat] = point;
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

/**
 * Segment-against-box intersection, by the Liang-Barsky slab method.
 *
 * Walking the segment's parameter t from 0 to 1, each of the four box edges
 * either lets t through or clips it. If anything survives the clipping, the
 * segment enters the box.
 *
 * Chosen over sampling points along the segment because sampling has a hole in
 * it: a straight road crossing the corner of a cell can pass between two
 * samples however finely they are spaced, and that hole is exactly the case
 * this function exists to catch.
 */
export function segmentIntersectsBox(a: Position, b: Position, box: Bounds): boolean {
  if (isInsideBox(a, box) || isInsideBox(b, box)) return true;

  const dx = b[0] - a[0];
  const dy = b[1] - a[1];

  let tMin = 0;
  let tMax = 1;

  const clip = (direction: number, distance: number): boolean => {
    if (direction === 0) {
      // Parallel to this pair of edges, so this slab cannot clip it: it is
      // out only if it already lies on the wrong side. A due-east route along
      // a street is exactly this case, which is why the sign matters.
      return distance >= 0;
    }
    const t = distance / direction;
    if (direction < 0) {
      if (t > tMax) return false;
      if (t > tMin) tMin = t;
    } else {
      if (t < tMin) return false;
      if (t < tMax) tMax = t;
    }
    return true;
  };

  return (
    clip(-dx, a[0] - box.west) &&
    clip(dx, box.east - a[0]) &&
    clip(-dy, a[1] - box.south) &&
    clip(dy, box.north - a[1])
  );
}

/**
 * Does this path touch the box at any point along its length?
 *
 * A single-point path is treated as its own position, so a route that begins
 * and ends inside a flooded cell is still caught.
 */
export function pathIntersectsBox(path: readonly Position[], box: Bounds): boolean {
  if (path.length === 0) return false;
  if (path.length === 1) return isInsideBox(path[0]!, box);

  for (let i = 1; i < path.length; i += 1) {
    if (segmentIntersectsBox(path[i - 1]!, path[i]!, box)) return true;
  }
  return false;
}

/** The boxes this path touches. Named so the explanation can count them. */
export function boxesOnPath<T extends { bounds: Bounds }>(
  path: readonly Position[],
  boxes: readonly T[],
): T[] {
  return boxes.filter((candidate) => pathIntersectsBox(path, candidate.bounds));
}

/**
 * Tolerance for calling two grid edges the same edge.
 *
 * Geohash bounds come from repeated halving of [-180, 180] and [-90, 90], so
 * two adjacent cells produce a bit-identical shared edge. The epsilon is
 * insurance rather than necessity, and is four orders of magnitude below the
 * 0.0007 degree height of a precision-7 cell, so it can never fuse cells that
 * are genuinely apart.
 */
const EDGE_EPSILON = 1e-9;

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= EDGE_EPSILON;
}

/** Do these two boxes touch or overlap along the west-east axis? */
function adjacentHorizontally(a: Bounds, b: Bounds): boolean {
  return a.east >= b.west - EDGE_EPSILON && b.east >= a.west - EDGE_EPSILON;
}

function adjacentVertically(a: Bounds, b: Bounds): boolean {
  return a.north >= b.south - EDGE_EPSILON && b.north >= a.south - EDGE_EPSILON;
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/**
 * Coalesce a set of grid cells into the smallest run of rectangles that covers
 * exactly the same ground.
 *
 * Two passes: first join cells that share a full north-south edge into runs
 * along a row, then join runs that span identical west-east extents into
 * blocks. This is the classic two-pass rectangle coalescing, and it is not
 * minimal -- an L-shaped flood stays two rectangles -- but a contiguous block
 * of flooding, which is what flooding actually looks like, collapses from
 * dozens of cells to one.
 *
 * Only exact merges are performed: the result covers the same area as the
 * input, never more. That matters because the caller hands these to the router
 * as areas to avoid, and a box grown over dry ground would close roads that
 * are open.
 */
export function mergeBounds(boxes: readonly Bounds[]): Bounds[] {
  if (boxes.length <= 1) return boxes.map((box) => ({ ...box }));

  // Along each row: same south and north, touching along west-east.
  const rows = [...boxes].sort((a, b) => a.south - b.south || a.west - b.west);
  const runs: Bounds[] = [];

  for (const box of rows) {
    const previous = runs[runs.length - 1];
    if (
      previous &&
      same(previous.south, box.south) &&
      same(previous.north, box.north) &&
      adjacentHorizontally(previous, box)
    ) {
      runs[runs.length - 1] = union(previous, box);
      continue;
    }
    runs.push({ ...box });
  }

  // Stacked rows: same west and east, touching along south-north.
  const columns = runs.sort((a, b) => a.west - b.west || a.south - b.south);
  const blocks: Bounds[] = [];

  for (const run of columns) {
    const previous = blocks[blocks.length - 1];
    if (
      previous &&
      same(previous.west, run.west) &&
      same(previous.east, run.east) &&
      adjacentVertically(previous, run)
    ) {
      blocks[blocks.length - 1] = union(previous, run);
      continue;
    }
    blocks.push({ ...run });
  }

  return blocks;
}

/** The smallest box containing every point, grown by `padDegrees` on each side. */
export function boundingBox(points: readonly Position[], padDegrees = 0): Bounds {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  return {
    west: west - padDegrees,
    south: south - padDegrees,
    east: east + padDegrees,
    north: north + padDegrees,
  };
}
