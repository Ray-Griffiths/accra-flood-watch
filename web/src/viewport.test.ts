import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RISK_MIN_ZOOM,
  clampBbox,
  isUsableBbox,
  latFromMercatorY,
  mercatorYFromLat,
  viewportBboxFor,
  type Bbox,
} from "./viewport.ts";

const ACCRA: [number, number] = [-0.21, 5.5925];
/** A 390x844 phone, the device the whole interface is sized for. */
const PHONE = { width: 390, height: 844 };

describe("mercator projection", () => {
  it("round-trips a latitude", () => {
    for (const latitude of [0, 5.5925, -33.9, 51.5, 85]) {
      const back = latFromMercatorY(mercatorYFromLat(latitude));
      assert.ok(
        Math.abs(back - latitude) < 1e-9,
        `${latitude} came back as ${back}`,
      );
    }
  });

  it("puts the equator halfway down the world", () => {
    assert.ok(Math.abs(mercatorYFromLat(0) - 0.5) < 1e-12);
  });

  it("grows southward", () => {
    // The sign convention the viewport maths depends on: a smaller y is
    // further north. Getting this backwards silently flips the box.
    assert.ok(mercatorYFromLat(10) < mercatorYFromLat(0));
    assert.ok(mercatorYFromLat(-10) > mercatorYFromLat(0));
  });

  it("clamps beyond the projection limit rather than returning infinity", () => {
    assert.ok(Number.isFinite(mercatorYFromLat(90)));
    assert.ok(Number.isFinite(mercatorYFromLat(-90)));
  });
});

describe("viewportBboxFor", () => {
  it("centres the box on the given point", () => {
    const [west, south, east, north] = viewportBboxFor(
      ACCRA,
      14,
      PHONE.width,
      PHONE.height,
    );
    assert.ok(Math.abs((west + east) / 2 - ACCRA[0]) < 1e-9);
    // Latitude is not linear in Mercator, so the centre is only approximately
    // midway between the edges. Close enough that a 152m cell cannot hide in
    // the difference.
    assert.ok(Math.abs((south + north) / 2 - ACCRA[1]) < 1e-4);
  });

  it("produces a well-formed box", () => {
    const box = viewportBboxFor(ACCRA, 14, PHONE.width, PHONE.height);
    assert.ok(isUsableBbox(box));
  });

  it("halves the span for each zoom level gained", () => {
    const [west14, , east14] = viewportBboxFor(ACCRA, 14, PHONE.width, PHONE.height);
    const [west15, , east15] = viewportBboxFor(ACCRA, 15, PHONE.width, PHONE.height);
    const ratio = (east14 - west14) / (east15 - west15);
    assert.ok(Math.abs(ratio - 2) < 1e-9, `expected 2, got ${ratio}`);
  });

  it("is taller than it is wide on a portrait phone", () => {
    const [west, south, east, north] = viewportBboxFor(
      ACCRA,
      14,
      PHONE.width,
      PHONE.height,
    );
    assert.ok(north - south > east - west);
  });

  it("matches a hand-checked span at the default zoom", () => {
    // At zoom 14 the world is 512 * 2^14 = 8,388,608 px, so one pixel is
    // 360 / 8,388,608 degrees of longitude. 390 px is therefore ~0.016736.
    const [west, , east] = viewportBboxFor(ACCRA, 14, PHONE.width, PHONE.height);
    const expected = (390 * 360) / (512 * 2 ** 14);
    assert.ok(Math.abs(east - west - expected) < 1e-12);
  });

  it("keeps the opening request far smaller than the whole catchment", () => {
    // The reason this module exists. The Odaw block is 0.08 x 0.115 degrees;
    // an opening viewport must be a fraction of that, not all of it.
    const [west, south, east, north] = viewportBboxFor(
      ACCRA,
      14,
      PHONE.width,
      PHONE.height,
    );
    assert.ok(east - west < 0.08 / 2);
    assert.ok(north - south < 0.115 / 2);
  });
});

describe("clampBbox", () => {
  const envelope: Bbox = [-0.25, 5.535, -0.17, 5.65];

  it("trims a box that overhangs the envelope", () => {
    assert.deepEqual(clampBbox([-0.4, 5.4, -0.1, 5.8], envelope), [
      -0.25, 5.535, -0.17, 5.65,
    ]);
  });

  it("leaves a box already inside alone", () => {
    const inside: Bbox = [-0.22, 5.56, -0.2, 5.58];
    assert.deepEqual(clampBbox(inside, envelope), inside);
  });

  it("produces an unusable box when there is no overlap", () => {
    // Caller checks with isUsableBbox and skips the request rather than
    // asking the API for a box that means nothing.
    assert.equal(isUsableBbox(clampBbox([0.1, 5.5, 0.2, 5.6], envelope)), false);
  });
});

describe("isUsableBbox", () => {
  it("accepts a normal box", () => {
    assert.equal(isUsableBbox([-0.22, 5.56, -0.2, 5.58]), true);
  });

  it("rejects an inverted or empty box", () => {
    assert.equal(isUsableBbox([-0.2, 5.56, -0.22, 5.58]), false);
    assert.equal(isUsableBbox([-0.2, 5.58, -0.2, 5.58]), false);
  });

  it("rejects non-finite values", () => {
    assert.equal(isUsableBbox([Number.NaN, 5.56, -0.2, 5.58]), false);
  });
});

describe("RISK_MIN_ZOOM", () => {
  it("is set where a phone viewport stays inside the request cap", () => {
    // At this zoom a 390x844 viewport spans roughly 0.033 x 0.072 degrees,
    // which is about 56 geohash-6 partitions -- close to what the original
    // pilot area needed and well inside the cap of 128.
    const [west, south, east, north] = viewportBboxFor(
      ACCRA,
      RISK_MIN_ZOOM,
      PHONE.width,
      PHONE.height,
    );
    const columns = Math.ceil((east - west) / 0.010986) + 1;
    const rows = Math.ceil((north - south) / 0.005493) + 1;
    assert.ok(columns * rows <= 128, `${columns * rows} partitions at z${RISK_MIN_ZOOM}`);
  });
});
