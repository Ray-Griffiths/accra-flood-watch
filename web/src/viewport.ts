/**
 * What the map will be looking at, worked out before the map exists.
 *
 * The risk overlay is fetched in parallel with map creation, on purpose: it
 * carries the information that matters, and on a slow connection the request
 * that goes out second is the one that does not arrive. That meant the first
 * fetch could not ask the map what was on screen, so it asked for the whole
 * covered area instead.
 *
 * With a pilot-sized box that was merely wasteful. Over a whole catchment it
 * is roughly 5,000 cells and two megabytes, nearly all of it off-screen, sent
 * to a phone on mobile data before the map has drawn anything.
 *
 * So the first viewport is computed here from the centre, the zoom and the
 * size of the container -- all known before MapLibre starts -- and the request
 * still leaves first. Everything afterwards uses the real viewport from the
 * map itself.
 */

/** west, south, east, north -- the order the API uses. */
export type Bbox = [number, number, number, number];

/** MapLibre GL renders 512px tiles, so the world is 512 * 2^zoom pixels. */
const TILE_SIZE = 512;

/** The latitude past which the Mercator projection runs away to infinity. */
const MAX_MERCATOR_LATITUDE = 85.051129;

/**
 * Below this zoom the risk overlay is not drawn at all.
 *
 * Two reasons, and the second is the one that matters. A 152m cell is about
 * four pixels at zoom 11, so the overlay is visual noise rather than
 * information. And a zoomed-out viewport over the whole catchment needs more
 * partitions than one request returns, so what came back would be part of the
 * picture drawn as though it were all of it -- a blank corner that looks
 * exactly like low risk.
 *
 * At zoom 13 a phone viewport is roughly 3.7km x 8km and needs about 56
 * partitions, which is close to what the original pilot area needed in one
 * request and comfortably inside the cap. So the map can still be zoomed out
 * for orientation; it just says what it is doing instead of guessing.
 */
export const RISK_MIN_ZOOM = 13;

export function mercatorYFromLat(latitude: number): number {
  const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, latitude));
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))) / 360;
}

export function latFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90;
}

/**
 * The bounding box a map of this size would show at this centre and zoom.
 *
 * Longitude is linear in Mercator, so it falls straight out of the pixel
 * width. Latitude is not, which is why the vertical edges are computed in
 * projected space and converted back rather than being derived from a
 * degrees-per-pixel figure that is only correct at the centre line.
 */
export function viewportBboxFor(
  centre: readonly [number, number],
  zoom: number,
  widthPx: number,
  heightPx: number,
): Bbox {
  const [centreLon, centreLat] = centre;
  const worldSize = TILE_SIZE * Math.pow(2, zoom);

  const halfWidthDegrees = ((widthPx / 2) * 360) / worldSize;
  const west = centreLon - halfWidthDegrees;
  const east = centreLon + halfWidthDegrees;

  const centreY = mercatorYFromLat(centreLat);
  const halfHeight = heightPx / 2 / worldSize;
  // Mercator y grows southward, so the north edge is the smaller value.
  const north = latFromMercatorY(centreY - halfHeight);
  const south = latFromMercatorY(centreY + halfHeight);

  return [west, south, east, north];
}

/**
 * Clamp a box to a bounding envelope.
 *
 * Used so the opening request does not ask for ground off the edge of the
 * covered area. The server clips too -- this only keeps the URL honest and
 * the response small.
 */
export function clampBbox(box: Bbox, envelope: Bbox): Bbox {
  const [west, south, east, north] = box;
  const [envWest, envSouth, envEast, envNorth] = envelope;
  return [
    Math.max(west, envWest),
    Math.max(south, envSouth),
    Math.min(east, envEast),
    Math.min(north, envNorth),
  ];
}

/** Does this box enclose any ground at all? */
export function isUsableBbox(box: Bbox): boolean {
  const [west, south, east, north] = box;
  return (
    box.every((value) => Number.isFinite(value)) && west < east && south < north
  );
}
