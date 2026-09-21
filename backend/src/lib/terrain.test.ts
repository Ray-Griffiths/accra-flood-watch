/**
 * The terrain view: bands, wording, and the question "is rain coming at all".
 *
 * These decide what the map shows on a dry day, which is most days. The
 * boundary at every cut point is tested in both directions, because a cell
 * that sits exactly on a threshold is the one a reviewer will look at.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HIGH_THRESHOLD,
  WATCH_THRESHOLD,
  describeTerrain,
  explainTerrain,
  levelFromScore,
  terrainBand,
} from "./risk.ts";
import {
  RAIN_NONE_24H_MM,
  RAIN_NONE_6H_MM,
  RAIN_SIGNIFICANT_24H_MM,
  RAIN_SIGNIFICANT_6H_MM,
  rainOutlook,
} from "./scoring.ts";

describe("terrainBand", () => {
  it("bands a well-drained cell as usually dry", () => {
    assert.equal(terrainBand(0), "usually-dry");
    assert.equal(terrainBand(20), "usually-dry");
  });

  it("bands the middle of the range as flooding in heavy rain", () => {
    assert.equal(terrainBand(50), "floods-heavy");
    assert.equal(terrainBand(69.9), "floods-heavy");
  });

  it("bands the worst ground as flooding first", () => {
    assert.equal(terrainBand(80), "floods-first");
    assert.equal(terrainBand(100), "floods-first");
  });

  it("includes the watch boundary in the band above it", () => {
    assert.equal(terrainBand(WATCH_THRESHOLD - 0.1), "usually-dry");
    assert.equal(terrainBand(WATCH_THRESHOLD), "floods-heavy");
  });

  it("includes the high boundary in the band above it", () => {
    assert.equal(terrainBand(HIGH_THRESHOLD - 0.1), "floods-heavy");
    assert.equal(terrainBand(HIGH_THRESHOLD), "floods-first");
  });

  /**
   * Susceptibility IS the score for a cell with no forecast and no reports, so
   * the two band the same number. If these ever diverge, a cell reads `high`
   * in one view and "usually dry" in the other.
   */
  it("agrees with the risk level on every cut point", () => {
    const pairs: Array<[number, string]> = [
      [0, "low"],
      [WATCH_THRESHOLD - 0.1, "low"],
      [WATCH_THRESHOLD, "watch"],
      [HIGH_THRESHOLD - 0.1, "watch"],
      [HIGH_THRESHOLD, "high"],
      [100, "high"],
    ];
    const equivalent: Record<string, string> = {
      low: "usually-dry",
      watch: "floods-heavy",
      high: "floods-first",
    };

    for (const [value, level] of pairs) {
      assert.equal(levelFromScore(value), level, `level at ${value}`);
      assert.equal(terrainBand(value), equivalent[level], `band at ${value}`);
    }
  });
});

describe("describeTerrain", () => {
  it("says how far the ground sits above the drain", () => {
    assert.match(describeTerrain(80, 0.4), /barely above the nearest drain/);
    assert.match(describeTerrain(50, 2.5), /about 2\.5m above the nearest drain/);
    assert.match(describeTerrain(10, 12), /sits 12m above the nearest drain/);
  });

  it("names a recorded flood point when there is one", () => {
    const sentence = describeTerrain(80, 0.5, "Kaneshie Market");
    assert.match(sentence, /flooding has been recorded at Kaneshie Market/);
  });

  it("omits the flood point clause entirely when there is none", () => {
    assert.doesNotMatch(describeTerrain(80, 0.5), /recorded/);
  });

  it("states the outlook for the band", () => {
    assert.match(describeTerrain(80, 0.5), /floods readily when it rains hard/);
    assert.match(describeTerrain(50, 2), /can flood in heavy rain/);
    assert.match(describeTerrain(10, 9), /drains reasonably well/);
  });

  /**
   * The terrain view states elsewhere that no rain is coming. Repeating it
   * here as a caveat would read as a fault rather than as the point.
   */
  it("carries no forecast caveat, unlike the terrain-only fallback", () => {
    assert.doesNotMatch(describeTerrain(80, 0.5), /forecast/i);
    assert.match(explainTerrain(80, 0.5), /No rainfall forecast yet/);
  });

  it("starts with a capital and ends with a full stop", () => {
    const sentence = describeTerrain(50, 2, "Avenor");
    assert.match(sentence, /^[A-Z]/);
    assert.match(sentence, /\.$/);
  });
});

describe("rainOutlook", () => {
  it("calls a dry day none", () => {
    assert.equal(rainOutlook({ next6hMm: 0, next24hMm: 0 }), "none");
    assert.equal(rainOutlook({ next6hMm: 0.4, next24hMm: 1.2 }), "none");
  });

  it("calls a drizzle light", () => {
    assert.equal(rainOutlook({ next6hMm: 3, next24hMm: 6 }), "light");
  });

  it("calls real rain significant", () => {
    assert.equal(rainOutlook({ next6hMm: 25, next24hMm: 40 }), "significant");
  });

  it("puts each boundary in the wetter class", () => {
    assert.equal(rainOutlook({ next6hMm: RAIN_NONE_6H_MM, next24hMm: 0 }), "light");
    assert.equal(rainOutlook({ next6hMm: 0, next24hMm: RAIN_NONE_24H_MM }), "light");
    assert.equal(rainOutlook({ next6hMm: RAIN_SIGNIFICANT_6H_MM, next24hMm: 0 }), "significant");
    assert.equal(rainOutlook({ next6hMm: 0, next24hMm: RAIN_SIGNIFICANT_24H_MM }), "significant");
  });

  /**
   * A cloudburst and a day of steady rain each flood on their own, so either
   * reading alone is enough to raise the outlook. Requiring both would let a
   * severe six-hour total be cancelled by a dry day around it.
   */
  it("raises on either reading alone", () => {
    assert.equal(rainOutlook({ next6hMm: 30, next24hMm: 30 }), "significant");
    assert.equal(rainOutlook({ next6hMm: 0, next24hMm: 60 }), "significant");
  });

  it("treats a non-finite reading as no rain rather than throwing", () => {
    assert.equal(rainOutlook({ next6hMm: Number.NaN, next24hMm: Number.NaN }), "none");
    assert.equal(rainOutlook({ next6hMm: Number.NaN, next24hMm: 40 }), "significant");
  });
});
