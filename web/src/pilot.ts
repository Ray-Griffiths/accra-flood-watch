/**
 * Is a position inside the area this project actually covers?
 *
 * The server checks this too, and rejects anything outside -- a report outside
 * the grid would be a point on a map the terrain model knows nothing about.
 * The problem was that the browser knew the boundary all along (it arrives in
 * `/api/config`) and did not consult it: it would take the device's GPS fix,
 * send it, and let the server refuse. Somebody a few streets outside Circle got
 * a failed report and a console error instead of an explanation.
 *
 * So this runs before the request, and the answer changes what the interface
 * says rather than what the server returns.
 *
 * Coverage is a list of areas rather than one box. A single bounding box drawn
 * around several separate neighbourhoods would claim everything between them,
 * which is how a report gets accepted over ground with no grid behind it.
 */

/** west, south, east, north — the order `/api/config` and `/api/risk` use. */
export type Bbox = readonly [number, number, number, number];

export interface CoverageArea {
  id: string;
  name: string;
  bbox: Bbox;
}

/**
 * Everything the interface needs to know about where this project applies.
 *
 * Carried as one object because the three parts must agree: an envelope that
 * does not match the areas frames the map over ground the areas exclude, and
 * a description that does not match them tells somebody they are outside a
 * place they are standing in.
 */
export interface Coverage {
  areas: CoverageArea[];
  /** Named for people, e.g. "Odaw basin: Korle Lagoon to Achimota". */
  description: string;
  /** Framing only. Never a boundary test — see `envelopeOf`. */
  envelope: Bbox;
}

function insideBox(bbox: Bbox, longitude: number, latitude: number): boolean {
  const [west, south, east, north] = bbox;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  );
}

/**
 * The covered area a position falls in, or null when it falls in none.
 *
 * Returning the area rather than a boolean lets the interface name where
 * somebody is when that helps, instead of only telling them where they are
 * not.
 */
export function areaContaining(
  areas: readonly CoverageArea[],
  longitude: number,
  latitude: number,
): CoverageArea | null {
  return areas.find((area) => insideBox(area.bbox, longitude, latitude)) ?? null;
}

export function isInsideCoverage(
  areas: readonly CoverageArea[],
  longitude: number,
  latitude: number,
): boolean {
  return areaContaining(areas, longitude, latitude) !== null;
}

/**
 * The smallest box containing every area.
 *
 * For framing the map only. Using it as the boundary would accept positions
 * in the gaps between disjoint areas, which is the whole reason coverage is
 * a list in the first place.
 */
export function envelopeOf(areas: readonly CoverageArea[]): Bbox | null {
  if (areas.length === 0) return null;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const area of areas) {
    west = Math.min(west, area.bbox[0]);
    south = Math.min(south, area.bbox[1]);
    east = Math.max(east, area.bbox[2]);
    north = Math.max(north, area.bbox[3]);
  }

  return [west, south, east, north];
}
