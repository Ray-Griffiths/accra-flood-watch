/**
 * The ramp, in both themes.
 *
 * The live ramp and the terrain ramp must never share a colour. The whole
 * two-view design rests on someone being unable to mistake "this street goes
 * under first" for "this street is under water now", and a shared hex would
 * quietly undo that in one of the two themes without touching the other.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEVEL_STYLES,
  RISK_LEVELS,
  TERRAIN_BANDS,
  TERRAIN_STYLES,
  colourFor,
  levelStyle,
  terrainStyle,
} from "./levels.ts";

const HEX = /^#[0-9a-f]{6}$/i;

describe("level colours", () => {
  it("defines both themes for every risk level", () => {
    for (const level of RISK_LEVELS) {
      const style = LEVEL_STYLES[level];
      assert.match(style.colour.light, HEX, `${level} light`);
      assert.match(style.colour.dark, HEX, `${level} dark`);
    }
  });

  it("defines both themes for every terrain band", () => {
    for (const band of TERRAIN_BANDS) {
      const style = TERRAIN_STYLES[band];
      assert.match(style.colour.light, HEX, `${band} light`);
      assert.match(style.colour.dark, HEX, `${band} dark`);
    }
  });

  it("resolves a concrete colour for either theme", () => {
    assert.equal(colourFor(LEVEL_STYLES.low, "dark"), LEVEL_STYLES.low.colour.dark);
    assert.equal(colourFor(LEVEL_STYLES.low, "light"), LEVEL_STYLES.low.colour.light);
  });

  it("never shares a colour between the live ramp and the terrain ramp", () => {
    for (const theme of ["light", "dark"] as const) {
      const live = RISK_LEVELS.map((l) => colourFor(LEVEL_STYLES[l], theme).toLowerCase());
      const terrain = TERRAIN_BANDS.map((b) => colourFor(TERRAIN_STYLES[b], theme).toLowerCase());
      for (const c of live) {
        assert.ok(!terrain.includes(c), `${c} appears in both ramps in ${theme}`);
      }
    }
  });

  it("keeps every level distinct within a theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const seen = RISK_LEVELS.map((l) => colourFor(LEVEL_STYLES[l], theme).toLowerCase());
      assert.equal(new Set(seen).size, seen.length, `duplicate level colour in ${theme}`);
    }
  });

  it("still falls back to the least alarming reading, never the most", () => {
    assert.equal(levelStyle("nonsense"), LEVEL_STYLES.low);
    assert.equal(terrainStyle("nonsense"), TERRAIN_STYLES["usually-dry"]);
  });

  it("gives every style a distinct CSS custom property", () => {
    const CSS_VAR = /^--k-[a-z]+$/;
    const names = [
      ...RISK_LEVELS.map((l) => LEVEL_STYLES[l].cssVariable),
      ...TERRAIN_BANDS.map((b) => TERRAIN_STYLES[b].cssVariable),
    ];
    for (const name of names) {
      assert.match(name, CSS_VAR, `${name} is not a --k-* custom property`);
    }
    assert.equal(new Set(names).size, names.length, "duplicate cssVariable across styles");
  });
});
