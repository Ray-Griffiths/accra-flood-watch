/**
 * The pilot area and the grid geometry, shared by every handler.
 *
 * These constants mirror `preprocessing/config.py`. If one side changes, the
 * other must change with it.
 */

import { type Bounds, cellsCovering, encode } from "./geohash.ts";

/** Circle / Kaneshie / Avenor, Accra. */
export const PILOT_BBOX: Bounds = {
  west: -0.245,
  south: 5.55,
  east: -0.195,
  north: 5.59,
};

/** Grid resolution: ~152m x 152m. */
export const CELL_PRECISION = 7;

/**
 * Partition-key resolution: ~1.2km x 0.6km, holding 32 grid cells.
 *
 * A viewport resolves to a handful of these, and each is one Query. The full
 * cell is the sort key. Partitioning by the full cell instead would turn a
 * viewport read into a BatchGetItem over every key in view.
 */
export const PREFIX_PRECISION = 6;

/**
 * Cap on prefixes fetched for one request. At ~1.2km per prefix this covers a
 * viewport far wider than the pilot area itself, so hitting the cap means a
 * malformed or hostile bbox rather than a legitimate wide zoom.
 */
export const MAX_PREFIXES_PER_REQUEST = 64;

export function isInsidePilotArea(latitude: number, longitude: number): boolean {
  return (
    longitude >= PILOT_BBOX.west &&
    longitude <= PILOT_BBOX.east &&
    latitude >= PILOT_BBOX.south &&
    latitude <= PILOT_BBOX.north
  );
}

export function cellFor(latitude: number, longitude: number): string {
  return encode(latitude, longitude, CELL_PRECISION);
}

export function prefixFor(latitude: number, longitude: number): string {
  return encode(latitude, longitude, PREFIX_PRECISION);
}

/** The prefix a full cell belongs to. Cheaper than re-encoding coordinates. */
export function prefixOfCell(cell: string): string {
  return cell.slice(0, PREFIX_PRECISION);
}

/**
 * Clip a requested viewport to the pilot area.
 *
 * Returns null when the viewport lies entirely outside, so handlers answer
 * with an empty result rather than querying for keys that cannot exist.
 */
export function clipToPilotArea(box: Bounds): Bounds | null {
  const clipped: Bounds = {
    west: Math.max(box.west, PILOT_BBOX.west),
    south: Math.max(box.south, PILOT_BBOX.south),
    east: Math.min(box.east, PILOT_BBOX.east),
    north: Math.min(box.north, PILOT_BBOX.north),
  };
  if (clipped.west >= clipped.east || clipped.south >= clipped.north) return null;
  return clipped;
}

/** Partition keys covering a viewport, already clipped and capped. */
export function prefixesForViewport(box: Bounds): string[] {
  const clipped = clipToPilotArea(box);
  if (!clipped) return [];
  return cellsCovering(clipped, PREFIX_PRECISION).slice(
    0,
    MAX_PREFIXES_PER_REQUEST,
  );
}

/**
 * Parse a `bbox=west,south,east,north` query parameter.
 *
 * Returns null on anything malformed. Handlers translate that into a 400
 * rather than guessing at what the caller meant.
 */
export function parseBbox(raw: string | undefined): Bounds | null {
  if (!raw) return null;
  const parts = raw.split(",").map((value) => Number.parseFloat(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west >= east || south >= north) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  if (Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north };
}
