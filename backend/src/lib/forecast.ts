/**
 * Rainfall forecasts from Open-Meteo.
 *
 * Chosen in section 8 of the plan for one decisive reason: no API key. There
 * is no secret to rotate, nothing to leak, and nothing to configure before a
 * fresh deployment works. For a pilot calling it once an hour, free
 * non-commercial use is a comfortable fit.
 *
 * The pilot area is roughly 5.5km x 4.5km. Rainfall does vary across that, but
 * not enough to justify 1,140 separate lookups, so a handful of representative
 * points are fetched in a single request and each cell takes the nearest one.
 *
 * Every failure path here returns null rather than throwing or substituting
 * zero. A forecast that is absent must stay visibly absent all the way to the
 * user; a forecast quietly replaced by "no rain" is how a warning system tells
 * people a flood is not coming.
 */

import { PILOT_BBOX } from "./pilot.ts";
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
 * Four points at the quarter positions of the pilot bounding box.
 *
 * Quarter positions rather than corners so that every cell has a sample point
 * reasonably close to it, instead of the middle of the area being equidistant
 * from four far-away readings.
 */
export function samplePoints(): Array<{ latitude: number; longitude: number }> {
  const { west, south, east, north } = PILOT_BBOX;
  const lons = [west + (east - west) * 0.25, west + (east - west) * 0.75];
  const lats = [south + (north - south) * 0.25, south + (north - south) * 0.75];

  const points: Array<{ latitude: number; longitude: number }> = [];
  for (const latitude of lats) {
    for (const longitude of lons) {
      points.push({ latitude, longitude });
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
