/**
 * Every foreground/background token pair, in both themes, against WCAG AA.
 *
 * This parses styles.css rather than restating the hex values, because a test
 * holding its own copy of the palette passes happily while the shipped one
 * regresses.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector + " {");
  assert.notEqual(start, -1, `missing block: ${selector}`);
  const body = CSS.slice(start, CSS.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  // All three channels go through `channel()`. Passing blue through raw -- a
  // 0-255 term against two 0-1 ones -- makes it swamp the sum, which reports
  // ratios near 2:1 for pairs that are genuinely 12:1 and, worse, would pass
  // some genuinely illegible pairs. sanity.test below pins the arithmetic.
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function ratio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Foreground token, background token. Both must be opaque hex. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--ink", "--surface-solid"],
  ["--ink-2", "--surface-solid"],
  ["--ink", "--btn-bg"],
  ["--legal-ink", "--legal-bg"],
  ["--legal-strong", "--legal-bg"],
  ["--cta-ink", "--cta-bg"],
  ["--seg-on-ink", "--seg-on-bg"],
];

/**
 * Tokens that carry no colour and so have nothing to restate per theme. Any
 * token NOT on this list has to be defined in both blocks -- see the last test.
 */
const THEME_NEUTRAL: ReadonlySet<string> = new Set(["--radius", "--safe-bottom"]);

describe("contrast arithmetic", () => {
  /*
   * The palette tests below are only as good as this function, and a wrong
   * one is invisible -- it reports a number either way. These three are the
   * published WCAG reference points, so a regression in `luminance` shows up
   * here rather than as a silently mis-measured theme.
   */
  it("reproduces the published reference ratios", () => {
    assert.equal(Math.round(ratio("#000000", "#ffffff")), 21);
    assert.equal(Math.round(ratio("#ffffff", "#ffffff")), 1);
    // The canonical "smallest grey that still passes AA on white".
    assert.ok(Math.abs(ratio("#767676", "#ffffff") - 4.54) < 0.02);
  });

  it("is symmetric in its arguments", () => {
    assert.equal(ratio("#16222b", "#e8f1f5"), ratio("#e8f1f5", "#16222b"));
  });

  it("expands three-digit hex", () => {
    assert.equal(ratio("#000", "#fff"), ratio("#000000", "#ffffff"));
  });
});

describe("theme contrast", () => {
  const darkBlock = block(":root");
  const lightBlock = block(':root[data-theme="light"]');
  const dark = darkBlock;
  const light = { ...darkBlock, ...lightBlock };

  for (const [themeName, tokens] of [["dark", dark], ["light", light]] as const) {
    for (const [fg, bg] of PAIRS) {
      it(`${themeName}: ${fg} on ${bg} meets AA`, () => {
        const f = tokens[fg];
        const b = tokens[bg];
        assert.ok(f, `${fg} undefined in ${themeName}`);
        assert.ok(b, `${bg} undefined in ${themeName}`);
        assert.match(f!, /^#[0-9a-f]{3,6}$/i, `${fg} must be opaque hex`);
        assert.match(b!, /^#[0-9a-f]{3,6}$/i, `${bg} must be opaque hex`);
        const r = ratio(f!, b!);
        assert.ok(r >= 4.5, `${fg} on ${bg} in ${themeName} is ${r.toFixed(2)}:1, need 4.5:1`);
      });
    }
  }

  /*
   * The map reads hex from levels.ts; the legend, the search badges and the
   * detail sheet read these tokens. Nothing but this test stops the legend
   * drifting from the cells it claims to explain.
   */
  it("matches the ramp in levels.ts, in both themes", async () => {
    const { LEVEL_STYLES, TERRAIN_STYLES } = await import("./levels.ts");
    const all = { ...LEVEL_STYLES, ...TERRAIN_STYLES };
    for (const style of Object.values(all)) {
      assert.equal(
        dark[style.cssVariable]?.toLowerCase(),
        style.colour.dark.toLowerCase(),
        `${style.cssVariable} dark`,
      );
      assert.equal(
        light[style.cssVariable]?.toLowerCase(),
        style.colour.light.toLowerCase(),
        `${style.cssVariable} light`,
      );
    }
  });

  it("defines every colour token in light that it defines in dark", () => {
    // Against `lightBlock`, not the merged `light`. `light` is spread FROM
    // `dark`, so every dark key is present in it by construction and the same
    // check written against it can never fail -- it would pass on a light
    // theme that defined nothing at all.
    const missing = Object.keys(darkBlock).filter(
      (k) => !THEME_NEUTRAL.has(k) && !(k in lightBlock),
    );
    assert.deepEqual(missing, [], `tokens missing from the light theme: ${missing.join(", ")}`);
  });

  it("does not restate a theme-neutral token in the light block", () => {
    // The flip side: a token listed as neutral but redefined per theme is
    // either mislabelled here or genuinely theme-dependent, and either way the
    // test above has stopped covering it.
    const restated = [...THEME_NEUTRAL].filter((k) => k in lightBlock);
    assert.deepEqual(restated, [], `neutral tokens redefined for light: ${restated.join(", ")}`);
  });
});
