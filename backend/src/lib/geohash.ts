/**
 * Geohash encoding. A direct port of `preprocessing/geohashing.py`.
 *
 * These two implementations MUST agree byte for byte. The Python side builds
 * the grid and assigns every cell its key; this side resolves a map viewport
 * and routes an incoming report to a cell. A divergence would silently write
 * reports into cells that the grid does not contain.
 *
 * `test/geohash.test.ts` checks both against the same reference vectors.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function encode(
  latitude: number,
  longitude: number,
  precision: number,
): string {
  const latRange = [-90, 90];
  const lonRange = [-180, 180];
  const geohash: string[] = [];
  let bits = 0;
  let bitCount = 0;
  let useLongitude = true;

  while (geohash.length < precision) {
    if (useLongitude) {
      const mid = (lonRange[0]! + lonRange[1]!) / 2;
      if (longitude > mid) {
        bits = (bits << 1) | 1;
        lonRange[0] = mid;
      } else {
        bits <<= 1;
        lonRange[1] = mid;
      }
    } else {
      const mid = (latRange[0]! + latRange[1]!) / 2;
      if (latitude > mid) {
        bits = (bits << 1) | 1;
        latRange[0] = mid;
      } else {
        bits <<= 1;
        latRange[1] = mid;
      }
    }

    useLongitude = !useLongitude;
    bitCount += 1;

    if (bitCount === 5) {
      geohash.push(BASE32[bits]!);
      bits = 0;
      bitCount = 0;
    }
  }

  return geohash.join("");
}

export function bounds(geohash: string): Bounds {
  const latRange = [-90, 90];
  const lonRange = [-180, 180];
  let useLongitude = true;

  for (const character of geohash) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`Invalid geohash character: ${character}`);
    for (let shift = 4; shift >= 0; shift -= 1) {
      const bit = (index >> shift) & 1;
      if (useLongitude) {
        const mid = (lonRange[0]! + lonRange[1]!) / 2;
        lonRange[bit ? 0 : 1] = mid;
      } else {
        const mid = (latRange[0]! + latRange[1]!) / 2;
        latRange[bit ? 0 : 1] = mid;
      }
      useLongitude = !useLongitude;
    }
  }

  return {
    west: lonRange[0]!,
    south: latRange[0]!,
    east: lonRange[1]!,
    north: latRange[1]!,
  };
}

export function cellSize(precision: number): { width: number; height: number } {
  const longitudeBits = Math.floor((precision * 5 + 1) / 2);
  const latitudeBits = Math.floor((precision * 5) / 2);
  return {
    width: 360 / 2 ** longitudeBits,
    height: 180 / 2 ** latitudeBits,
  };
}

/**
 * Every geohash cell at `precision` intersecting the box.
 *
 * Used to turn a map viewport into the set of partition keys to query. The
 * caller is responsible for capping how many it will actually fetch.
 */
export function cellsCovering(box: Bounds, precision: number): string[] {
  const { width, height } = cellSize(precision);

  // Snap to the cell lattice so the walk lands mid-cell and cannot skip one.
  const startLon = Math.floor(box.west / width) * width + width / 2;
  const startLat = Math.floor(box.south / height) * height + height / 2;

  const seen = new Set<string>();
  for (let latitude = startLat; latitude <= box.north + height; latitude += height) {
    for (let longitude = startLon; longitude <= box.east + width; longitude += width) {
      const cell = encode(latitude, longitude, precision);
      const cellBounds = bounds(cell);
      if (
        cellBounds.east > box.west &&
        cellBounds.west < box.east &&
        cellBounds.north > box.south &&
        cellBounds.south < box.north
      ) {
        seen.add(cell);
      }
    }
  }

  return [...seen].sort();
}

export function neighbours(geohash: string): string[] {
  const { west, south, east, north } = bounds(geohash);
  const centreLon = (west + east) / 2;
  const centreLat = (south + north) / 2;
  const width = east - west;
  const height = north - south;

  const result: string[] = [];
  for (const deltaLat of [-1, 0, 1]) {
    for (const deltaLon of [-1, 0, 1]) {
      if (deltaLat === 0 && deltaLon === 0) continue;
      result.push(
        encode(
          centreLat + deltaLat * height,
          centreLon + deltaLon * width,
          geohash.length,
        ),
      );
    }
  }
  return result;
}
