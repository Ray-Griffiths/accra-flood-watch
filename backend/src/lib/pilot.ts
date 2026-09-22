/**
 * The ground this project covers, and the grid geometry, shared by every
 * handler.
 *
 * Coverage is a LIST of areas rather than a single rectangle. The pilot was
 * one box, and every boundary check in the system quietly assumed there would
 * only ever be one. Extending coverage by widening that box would have worked
 * exactly once; the next areas worth adding (Dansoman, Weija, Madina) are not
 * adjacent to anything, and a bounding box drawn around all of them would
 * claim thousands of cells over ground the terrain model has never seen.
 *
 * So the boundary is the union of named areas, and the gaps between them are
 * real: outside every area is outside coverage, and the answer to a request
 * there is "not covered", never "no risk here".
 *
 * These constants mirror `preprocessing/config.py`. If one side changes, the
 * other must change with it.
 */

import { type Bounds, cellsCovering, encode } from "./geohash.ts";

export interface CoveredArea {
  /** Stable identifier. Appears in API responses; do not renumber. */
  readonly id: string;
  /** Shown to users, so it must name places people recognise. */
  readonly name: string;
  readonly bounds: Bounds;
}

/**
 * Accra flooding is dominated by one system: the Odaw river draining to the
 * Korle Lagoon. The original pilot (Circle / Kaneshie / Avenor) sat in the
 * middle of it, which meant the map could show where water arrived but not
 * where it came from.
 *
 * This area is the catchment rather than a neighbourhood: the Korle Lagoon
 * outfall at the south, up through Agbogbloshie, Circle, Avenor, Alajo and
 * Nima, to the Achimota headwaters at the north. Modelling it as one block is
 * not tidiness -- HAND is measured against the nearest drainage, so cutting a
 * catchment into pieces computes a wrong height-above-drainage for every cell
 * near a cut. That is the same failure `BUFFER_DEGREES` exists to prevent in
 * the preprocessing step, and a contiguous domain avoids it outright.
 */
export const COVERED_AREAS: readonly CoveredArea[] = [
  {
    id: "odaw",
    name: "Odaw basin: Korle Lagoon to Achimota",
    bounds: { west: -0.25, south: 5.535, east: -0.17, north: 5.65 },
  },
];

/**
 * The smallest box containing every covered area.
 *
 * Used to frame the map and nothing else. It is deliberately NOT used to
 * decide whether a point is covered: with disjoint areas the envelope spans
 * the gaps between them, so a check against it would accept coordinates over
 * ground with no grid behind it.
 */
export const COVERAGE_ENVELOPE: Bounds = COVERED_AREAS.reduce<Bounds>(
  (envelope, area) => ({
    west: Math.min(envelope.west, area.bounds.west),
    south: Math.min(envelope.south, area.bounds.south),
    east: Math.max(envelope.east, area.bounds.east),
    north: Math.max(envelope.north, area.bounds.north),
  }),
  {
    west: Number.POSITIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    north: Number.NEGATIVE_INFINITY,
  },
);

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
 * Cap on prefixes fetched for one request.
 *
 * This is a guard against a hostile or malformed bbox, not a page size. The
 * client is expected to stay below it by requesting the viewport rather than
 * the whole coverage area -- at the zoom where the risk overlay is drawn a
 * phone viewport needs roughly 56 prefixes, so 128 leaves room for a tablet
 * in landscape without ever being reached in normal use.
 *
 * When it does bite, the response says so. Silently returning the first 128
 * prefixes would draw a map that is complete in one corner and blank in
 * another, with nothing on screen to distinguish the blank part from ground
 * that is genuinely at low risk.
 */
export const MAX_PREFIXES_PER_REQUEST = 128;

function contains(box: Bounds, latitude: number, longitude: number): boolean {
  return (
    longitude >= box.west &&
    longitude <= box.east &&
    latitude >= box.south &&
    latitude <= box.north
  );
}

/**
 * The area a point falls in, or null when it falls in none of them.
 *
 * Every function here takes the area list as an argument defaulting to
 * `COVERED_AREAS`. Production passes one area today, which would leave the
 * disjoint-area and overlap handling entirely unexercised if these read the
 * constant directly -- and those are the paths that decide whether a gap in
 * coverage reads as a gap or as safe ground.
 */
export function areaContaining(
  latitude: number,
  longitude: number,
  areas: readonly CoveredArea[] = COVERED_AREAS,
): CoveredArea | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return areas.find((area) => contains(area.bounds, latitude, longitude)) ?? null;
}

export function isInsideCoverage(
  latitude: number,
  longitude: number,
  areas: readonly CoveredArea[] = COVERED_AREAS,
): boolean {
  return areaContaining(latitude, longitude, areas) !== null;
}

/**
 * Coverage named in a sentence, for messages shown to people.
 *
 * Derived rather than written out, because the previous version of this
 * boundary had its area name typed into four separate rejection messages and
 * widening the box would have left all four describing the old one.
 */
export function describeCoverage(areas: readonly CoveredArea[] = COVERED_AREAS): string {
  const names = areas.map((area) => area.name);
  if (names.length === 0) return "the covered area";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
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
 * Clip a requested viewport against every covered area.
 *
 * Returns one box per area the viewport actually overlaps, so a viewport
 * spanning two areas produces two boxes and the gap between them produces
 * none. An empty array means the viewport lies entirely outside coverage.
 */
export function clipToCoverage(
  box: Bounds,
  areas: readonly CoveredArea[] = COVERED_AREAS,
): Bounds[] {
  const clipped: Bounds[] = [];

  for (const area of areas) {
    const intersection: Bounds = {
      west: Math.max(box.west, area.bounds.west),
      south: Math.max(box.south, area.bounds.south),
      east: Math.min(box.east, area.bounds.east),
      north: Math.min(box.north, area.bounds.north),
    };
    if (intersection.west >= intersection.east) continue;
    if (intersection.south >= intersection.north) continue;
    clipped.push(intersection);
  }

  return clipped;
}

export interface ViewportPrefixes {
  prefixes: string[];
  /** The cap was reached, so these prefixes are not the whole viewport. */
  truncated: boolean;
}

/**
 * Partition keys covering a viewport, clipped to coverage and capped.
 *
 * Deduplicated across areas: areas are allowed to overlap (the honest way to
 * add a neighbourhood that straddles an existing boundary), and without a set
 * the shared prefixes would be queried twice and every cell in them returned
 * twice.
 */
export function prefixesForViewport(
  box: Bounds,
  areas: readonly CoveredArea[] = COVERED_AREAS,
): ViewportPrefixes {
  const seen = new Set<string>();

  for (const clipped of clipToCoverage(box, areas)) {
    for (const prefix of cellsCovering(clipped, PREFIX_PRECISION)) {
      seen.add(prefix);
    }
  }

  const prefixes = [...seen].sort();
  if (prefixes.length <= MAX_PREFIXES_PER_REQUEST) {
    return { prefixes, truncated: false };
  }
  return { prefixes: prefixes.slice(0, MAX_PREFIXES_PER_REQUEST), truncated: true };
}

/**
 * Sanity bound on a route corridor.
 *
 * A corridor between two covered points cannot be larger than coverage
 * itself, so this is never reached today. It exists so that a future coverage
 * expansion fails loudly here rather than quietly verifying part of a route.
 */
export const MAX_CORRIDOR_PREFIXES = 512;

/**
 * Partition keys for a route corridor.
 *
 * Deliberately NOT capped the way a viewport is. A viewport that returns some
 * of its cells is a map missing a corner; a corridor that returns some of its
 * hazards is a route claimed to avoid flooding on the strength of having
 * looked at part of it. The first degrades, the second lies.
 *
 * So this returns every prefix in the corridor or, past the sanity bound,
 * null -- which the handler turns into a refusal rather than a route.
 */
export function prefixesForCorridor(
  box: Bounds,
  areas: readonly CoveredArea[] = COVERED_AREAS,
): string[] | null {
  const seen = new Set<string>();

  for (const clipped of clipToCoverage(box, areas)) {
    for (const prefix of cellsCovering(clipped, PREFIX_PRECISION)) {
      seen.add(prefix);
    }
  }

  if (seen.size > MAX_CORRIDOR_PREFIXES) return null;
  return [...seen].sort();
}

/**
 * Every partition key in every covered area.
 *
 * Bounded and known, so the hourly scoring job never scans. Deduplicated for
 * the same reason as above.
 */
export function coveragePrefixes(areas: readonly CoveredArea[] = COVERED_AREAS): string[] {
  const seen = new Set<string>();
  for (const area of areas) {
    for (const prefix of cellsCovering(area.bounds, PREFIX_PRECISION)) {
      seen.add(prefix);
    }
  }
  return [...seen].sort();
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
