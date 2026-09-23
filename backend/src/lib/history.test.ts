/**
 * The flood history tally.
 *
 * This feature exists at the edge of a promise: reports self-delete at 24
 * hours, and this outlives them. What makes that defensible is how little a
 * row says — a cell and a date, nothing else — so the tests below are as much
 * about the shape of the record as about the arithmetic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORY_RETENTION_DAYS, dayKey, markerFor, summarise } from "./history.ts";

const WHEN = new Date("2026-09-23T14:32:07.123Z");

describe("a day marker", () => {
  it("records a cell and a date and nothing else", () => {
    const marker = markerFor("ebzzdt7", WHEN);

    // The load-bearing assertion of this file. Anything more here — a time, a
    // depth, coordinates, an id — would make the tally traceable to a person
    // or a doorway, which is the whole thing it is designed not to be.
    assert.deepEqual(Object.keys(marker).sort(), ["cell", "day", "expiresAt"]);
    assert.equal(marker.cell, "ebzzdt7");
    assert.equal(marker.day, "2026-09-23");
  });

  it("discards the time of day", () => {
    const morning = markerFor("ebzzdt7", new Date("2026-09-23T06:00:00Z"));
    const night = markerFor("ebzzdt7", new Date("2026-09-23T23:59:00Z"));

    // Same key, so the second write replaces the first. A street with one
    // loud reporter must look exactly like a street with twenty quiet ones.
    assert.equal(morning.day, night.day);
  });

  it("expires so the record stays about current behaviour", () => {
    const marker = markerFor("ebzzdt7", WHEN);
    const lifetimeDays = (marker.expiresAt - WHEN.getTime() / 1000) / 86_400;
    assert.equal(Math.round(lifetimeDays), HISTORY_RETENTION_DAYS);
  });

  it("keys the day in UTC, consistently", () => {
    assert.equal(dayKey(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
    assert.equal(dayKey(new Date("2026-01-05T23:59:59Z")), "2026-01-05");
  });
});

describe("summarising", () => {
  it("says nothing at all for a cell with no history", () => {
    // Not "0 days". An absence of reports is evidence nobody with a phone has
    // walked past, not evidence the place does not flood, and a confident
    // zero would invert that.
    const summary = summarise([]);
    assert.equal(summary.sentence, null);
    assert.equal(summary.days, 0);
  });

  it("reports a single day as an observation, not a frequency", () => {
    const summary = summarise(["2026-09-23"]);
    assert.match(summary.sentence ?? "", /one day/);
    assert.doesNotMatch(summary.sentence ?? "", /separate days/);
  });

  it("counts distinct days", () => {
    const summary = summarise(["2026-09-21", "2026-09-22", "2026-09-23"]);
    assert.equal(summary.days, 3);
    assert.match(summary.sentence ?? "", /3 separate days/);
  });

  it("does not double-count a repeated day", () => {
    const summary = summarise(["2026-09-23", "2026-09-23", "2026-09-23"]);
    assert.equal(summary.days, 1);
  });

  it("names the window it is talking about", () => {
    assert.match(summarise(["2026-09-23"], 180).sentence ?? "", /6 months/);
    assert.match(summarise(["2026-09-23"], 365).sentence ?? "", /year/);
  });
});
