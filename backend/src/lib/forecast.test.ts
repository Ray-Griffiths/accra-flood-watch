import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { accumulate, nearestForecast, samplePoints, type ForecastPoint } from "./forecast.ts";
import { PILOT_BBOX } from "./pilot.ts";

/** A day of hourly stamps in the shape Open-Meteo actually returns them. */
function hours(count: number, startHour = 0): string[] {
  return Array.from({ length: count }, (_, i) => {
    const hour = startHour + i;
    const day = 21 + Math.floor(hour / 24);
    return `2026-09-${day}T${String(hour % 24).padStart(2, "0")}:00`;
  });
}

describe("sample points", () => {
  it("places four points inside the pilot area", () => {
    const points = samplePoints();
    assert.equal(points.length, 4);
    for (const point of points) {
      assert.ok(point.longitude > PILOT_BBOX.west && point.longitude < PILOT_BBOX.east);
      assert.ok(point.latitude > PILOT_BBOX.south && point.latitude < PILOT_BBOX.north);
    }
  });

  it("spreads them apart rather than clustering", () => {
    const points = samplePoints();
    const lons = new Set(points.map((p) => p.longitude));
    const lats = new Set(points.map((p) => p.latitude));
    assert.equal(lons.size, 2);
    assert.equal(lats.size, 2);
  });
});

describe("accumulate", () => {
  const times = hours(48);

  it("sums forward from the current hour, not from the start of the series", () => {
    // 1mm every hour all day. At 10:00, the next 6 hours hold 6mm -- not the
    // 10mm that has already fallen, and not the 48mm in the whole series.
    const values = Array.from({ length: 48 }, () => 1);
    const total = accumulate(times, values, new Date("2026-09-21T10:00:00Z"), 6);
    assert.equal(total, 6);
  });

  it("excludes rain that has already fallen", () => {
    const values = Array.from({ length: 48 }, (_, i) => (i < 10 ? 50 : 0));
    const total = accumulate(times, values, new Date("2026-09-21T10:00:00Z"), 6);
    assert.equal(total, 0);
  });

  it("includes the hour currently in progress", () => {
    // At 10:30 the 10:00-11:00 hour is still partly ahead, so it counts.
    const values = Array.from({ length: 48 }, (_, i) => (i === 10 ? 7 : 0));
    const total = accumulate(times, values, new Date("2026-09-21T10:30:00Z"), 6);
    assert.equal(total, 7);
  });

  it("covers a full 24 hour window", () => {
    const values = Array.from({ length: 48 }, () => 2);
    const total = accumulate(times, values, new Date("2026-09-21T10:00:00Z"), 24);
    assert.equal(total, 48);
  });

  it("stops at the end of the series rather than wrapping", () => {
    const values = Array.from({ length: 48 }, () => 1);
    // Late on the final day only a few hours remain.
    const total = accumulate(times, values, new Date("2026-09-22T20:00:00Z"), 24);
    assert.equal(total, 4);
  });

  it("tolerates nulls in the series", () => {
    const values: Array<number | null> = Array.from({ length: 48 }, () => 1);
    values[11] = null;
    values[12] = null;
    const total = accumulate(times, values, new Date("2026-09-21T10:00:00Z"), 6);
    assert.equal(total, 4);
  });

  it("returns null rather than zero when nothing is usable", () => {
    const values = Array.from({ length: 48 }, () => null);
    assert.equal(accumulate(times, values, new Date("2026-09-21T10:00:00Z"), 6), null);
    assert.equal(accumulate([], [], new Date(), 6), null);
  });

  it("returns null when the series ended before now", () => {
    const total = accumulate(times, Array.from({ length: 48 }, () => 1), new Date("2026-09-30T00:00:00Z"), 6);
    assert.equal(total, null);
  });
});

describe("nearestForecast", () => {
  const points: ForecastPoint[] = [
    { latitude: 5.56, longitude: -0.2325, forecast: { next6hMm: 1, next24hMm: 1 } },
    { latitude: 5.58, longitude: -0.2075, forecast: { next6hMm: 9, next24hMm: 9 } },
  ];

  it("picks the closer sample point", () => {
    const near = nearestForecast(points, 5.561, -0.232);
    assert.equal(near?.next6hMm, 1);

    const far = nearestForecast(points, 5.579, -0.208);
    assert.equal(far?.next6hMm, 9);
  });

  it("returns null when there are no points at all", () => {
    assert.equal(nearestForecast([], 5.57, -0.22), null);
  });
});
