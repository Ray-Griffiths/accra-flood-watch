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
