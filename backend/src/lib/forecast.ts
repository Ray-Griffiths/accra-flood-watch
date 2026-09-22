/**
 * Rainfall forecasts from Open-Meteo.
 *
 * Chosen in section 8 of the plan for one decisive reason: no API key. There
 * is no secret to rotate, nothing to leak, and nothing to configure before a
 * fresh deployment works. For a pilot calling it once an hour, free
 * non-commercial use is a comfortable fit.
 *
 * Rainfall varies across the covered area, but not per 152m cell, so a grid
 * of representative points is fetched in a single request and each cell takes
 * the nearest one. The grid is sized by area rather than fixed in count:
 * four points described the original 5.5km x 4.5km pilot well enough, and
 * would be close to meaningless spread over a whole river catchment.
 *
 * Every failure path here returns null rather than throwing or substituting
 * zero. A forecast that is absent must stay visibly absent all the way to the
 * user; a forecast quietly replaced by "no rain" is how a warning system tells
 * people a flood is not coming.
 */

import { COVERED_AREAS } from "./pilot.ts";
import type { RainfallForecast } from "./scoring.ts";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** Open-Meteo is normally fast; a slow reply must not eat the whole budget. */
const TIMEOUT_MS = 8000;

export interface ForecastPoint {
  latitude: number;
  longitude: number;
  forecast: RainfallForecast;
}

/**
 * Roughly 4km between sample points.
 *
 * Accra rain is convective and falls in cells of a few kilometres, so this is
 * about as coarse as a sample grid can be before it starts reporting one
 * neighbourhood's storm as another's dry afternoon.
 */
const SAMPLE_SPACING_DEGREES = 0.036;

/**
 * A grid of forecast sample points across every covered area.
 *
 * Points sit at the centres of their grid squares rather than on the edges,
 * so every point is inside the area it samples and two adjacent areas cannot
 * both put a point on the boundary they share.
 */
export function samplePoints(): Array<{ latitude: number; longitude: number }> {
  const points: Array<{ latitude: number; longitude: number }> = [];
  const seen = new Set<string>();

  for (const area of COVERED_AREAS) {
    const { west, south, east, north } = area.bounds;
    const columns = Math.max(2, Math.ceil((east - west) / SAMPLE_SPACING_DEGREES));
    const rows = Math.max(2, Math.ceil((north - south) / SAMPLE_SPACING_DEGREES));

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const longitude = west + ((column + 0.5) / columns) * (east - west);
        const latitude = south + ((row + 0.5) / rows) * (north - south);

        // Overlapping areas would otherwise pay for the same lookup twice.
        const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push({ latitude, longitude });
      }
    }
  }

  return points;
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  hourly?: {
    time?: string[];
    precipitation?: Array<number | null>;
  };
}

/**
 * Sum the next `hours` entries of the hourly precipitation series.
 *
 * Open-Meteo returns whole days from midnight in the requested timezone, so
 * the series starts in the past. The index of the current hour is found first
 * and the window runs forward from there: summing from the start of the array
 * would report rain that has already fallen as rain still to come.
 */
export function accumulate(
  times: readonly string[],
  values: readonly (number | null)[],
  from: Date,
  hours: number,
): number | null {
  if (times.length === 0 || values.length === 0) return null;

  let startIndex = -1;
  for (let i = 0; i < times.length; i += 1) {
    const stamp = Date.parse(`${times[i]}Z`);
    if (Number.isNaN(stamp)) continue;
    // The hour containing `from`, or the first one after it.
    if (stamp + 3_600_000 > from.getTime()) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) return null;

  let total = 0;
  let counted = 0;
  for (let i = startIndex; i < Math.min(times.length, startIndex + hours); i += 1) {
    const value = values[i];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      counted += 1;
    }
  }

  return counted === 0 ? null : Math.round(total * 100) / 100;
}

/**
 * Fetch forecasts for every sample point in one request.
 *
 * Returns null if the feed is unreachable, malformed, or answers without any
 * usable precipitation series. Callers must treat null as "unknown", never as
 * "dry".
 */
export async function fetchForecasts(now: Date = new Date()): Promise<ForecastPoint[] | null> {
  const points = samplePoints();

  const url = new URL(ENDPOINT);
  // Open-Meteo accepts parallel comma-separated coordinates and answers with
  // one object per location, so four points cost one request.
  url.searchParams.set("latitude", points.map((p) => p.latitude.toFixed(4)).join(","));
  url.searchParams.set("longitude", points.map((p) => p.longitude.toFixed(4)).join(","));
  url.searchParams.set("hourly", "precipitation");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "UTC");

  let payload: unknown;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      console.error(`Forecast feed returned ${response.status}`);
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error("Forecast feed unreachable", error);
    return null;
  }

  // A single coordinate yields an object; several yield an array.
  const entries = (Array.isArray(payload) ? payload : [payload]) as OpenMeteoResponse[];

  const results: ForecastPoint[] = [];
  for (const entry of entries) {
    const times = entry.hourly?.time;
    const values = entry.hourly?.precipitation;
    if (!Array.isArray(times) || !Array.isArray(values)) continue;

    const next6hMm = accumulate(times, values, now, 6);
    const next24hMm = accumulate(times, values, now, 24);
    if (next6hMm === null || next24hMm === null) continue;

    results.push({
      latitude: entry.latitude,
      longitude: entry.longitude,
      forecast: { next6hMm, next24hMm },
    });
  }

  return results.length === 0 ? null : results;
}

/**
 * The forecast for the sample point nearest a cell centre.
 *
 * Plain squared euclidean distance in degrees. Over an area this small, and
 * this close to the equator, the distortion is far below the resolution the
 * forecast itself has.
 */
export function nearestForecast(
  points: readonly ForecastPoint[],
  latitude: number,
  longitude: number,
): RainfallForecast | null {
  let best: ForecastPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const dLat = point.latitude - latitude;
    const dLon = point.longitude - longitude;
    const distance = dLat * dLat + dLon * dLon;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  return best ? best.forecast : null;
}
