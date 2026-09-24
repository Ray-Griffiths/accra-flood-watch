# Hybrid Interface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Accra Flood Watch's stacked-band layout with a map-first layered one in a new visual language, shipping both a light and a dark theme.

**Architecture:** The map becomes the stage; all chrome floats above it as absolutely-positioned overlays, so no overlay can push the page into scrolling. Every colour — cartography included — becomes a CSS custom property, and the risk ramp in `levels.ts` gains a light/dark pair. The dark basemap is a `color-scheme=Dark` parameter the client appends to the existing style URL, so no backend or CloudFormation change is needed.

**Tech Stack:** Vite, vanilla TypeScript, MapLibre GL JS v5 (pinned — never upgrade to v6), Amazon Location GeoMaps, Node's built-in test runner (`node --test --experimental-strip-types`).

**Spec:** `docs/superpowers/specs/2026-09-23-hybrid-interface-redesign-design.md`

## Global Constraints

- **Never break the public URL.** `https://d227oixun34mjp.cloudfront.net` must stay live. Verify `GET /health` returns 200 after any deploy.
- **This is a web-only change.** No `sam deploy`, no `template.yaml` edit, no Lambda edit. If a task appears to need one, stop and raise it.
- **Tests run with `npm test` from `web/`**, which is `node --test --experimental-strip-types src/**/*.test.ts`. Tests import `assert from "node:assert/strict"` and `{ describe, it } from "node:test"`. There is no vitest, no jest, no jsdom.
- **Typecheck with `npm run typecheck`** from `web/` (`tsc --noEmit`). It must pass at the end of every task.
- **These existing test files must stay green and unmodified:** `view.test.ts`, `viewport.test.ts`, `pilot.test.ts`, `queue.test.ts`, `search.test.ts`, `i18n.test.ts`, `url-state.test.ts`, `commute.test.ts`, `api.test.ts`. If one needs changing, something out of scope has moved.
- **Minimum type size is 12px** anywhere in the phone UI.
- **Saturated colour is reserved for risk levels.** Status and freshness use neutrals plus `--live`. `Report water` must never use a ramp colour.
- **Risk levels keep shape and label as well as colour.** Do not remove patterns or text labels.
- **The disclaimer stays permanently visible** and keeps pointing at NADMO and the Ghana Meteorological Agency.
- **The service worker must keep excluding `/v2/*`**, or map tiles cache without bound.
- **MapLibre stays at `^5.24.0`.**

---

### Task 1: Theme resolution module

Pure logic, no DOM mutation, no map. Everything later builds on it.

**Files:**
- Create: `web/src/theme.ts`
- Test: `web/src/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Theme = "light" | "dark"`; `type ThemeChoice = Theme | "system"`; `readStoredChoice(storage: StorageLike): ThemeChoice`; `storeChoice(storage: StorageLike, choice: ThemeChoice): void`; `resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme`; `nextChoice(current: Theme): ThemeChoice`; `THEME_STORAGE_KEY`. `StorageLike` is `{ getItem(k: string): string | null; setItem(k: string, v: string): void }`.

- [ ] **Step 1: Write the failing test**

Create `web/src/theme.test.ts`:

```ts
/**
 * Theme resolution.
 *
 * The rule that matters is the third one: a user who has never chosen keeps
 * following their system, so a phone that switches to dark at dusk takes the
 * app with it. Latching to a default at first load would quietly opt everyone
 * out of that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THEME_STORAGE_KEY,
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
} from "./theme.ts";

function storage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string): string | null => (k in data ? data[k]! : null),
    setItem: (k: string, v: string): void => {
      data[k] = v;
    },
    read: (): Record<string, string> => data,
  };
}

describe("theme", () => {
  it("defaults to following the system when nothing is stored", () => {
    assert.equal(readStoredChoice(storage()), "system");
  });

  it("follows the system preference in both directions while unchosen", () => {
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
  });

  it("lets a manual choice win over the system preference", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("round-trips a stored choice", () => {
    const s = storage();
    storeChoice(s, "dark");
    assert.equal(s.read()[THEME_STORAGE_KEY], "dark");
    assert.equal(readStoredChoice(s), "dark");
  });

  it("falls back to following the system on a corrupted value", () => {
    assert.equal(readStoredChoice(storage({ [THEME_STORAGE_KEY]: "purple" })), "system");
  });

  it("survives storage that throws, rather than blanking the app", () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("denied");
      },
    };
    assert.equal(readStoredChoice(hostile), "system");
    assert.doesNotThrow(() => storeChoice(hostile, "dark"));
  });

  it("toggles to the opposite of what is on screen", () => {
    assert.equal(nextChoice("dark"), "light");
    assert.equal(nextChoice("light"), "dark");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd web && npm test
```

Expected: FAIL — `Cannot find module './theme.ts'`.

- [ ] **Step 3: Write the implementation**

Create `web/src/theme.ts`:

```ts
/**
 * Which theme the interface is wearing, and who decided.
 *
 * Dark is the condition this app is opened in -- rain, often after dark. But a
 * dark map is genuinely harder to read in direct midday sun, so the light pair
 * is not a preference bolted on afterwards, it is the answer to that problem.
 *
 * Storage is treated as hostile throughout: private browsing and locked-down
 * profiles both throw on access, and a flood map that fails to render because
 * it could not read a colour preference would be a poor trade.
 */

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

export const THEME_STORAGE_KEY = "afw.theme";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Anything unrecognised means "nobody has chosen", never a hard default. */
export function readStoredChoice(storage: StorageLike): ThemeChoice {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isChoice(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function storeChoice(storage: StorageLike, choice: ThemeChoice): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A preference we cannot persist is still a preference we can honour for
    // this session. Failing here must never reach the user.
  }
}

/**
 * A manual choice wins. Absent one, the system decides -- and keeps deciding,
 * so the app follows a phone that switches at dusk.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === "light" || choice === "dark") return choice;
  return prefersDark ? "dark" : "light";
}

/** The switch acts on what is on screen, not on what was last stored. */
export function nextChoice(current: Theme): ThemeChoice {
  return current === "dark" ? "light" : "dark";
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd web && npm test && npm run typecheck
```

Expected: all `theme` tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/theme.ts web/src/theme.test.ts
git commit -m "Add theme resolution that keeps following the system until chosen"
```

---

### Task 2: Theme-aware risk ramp

`LevelStyle.colour` becomes a light/dark pair. Three consumers must follow, or `tsc` fails — which is the point: the type change finds every call site.

**Files:**
- Modify: `web/src/levels.ts`
- Modify: `web/src/patterns.ts`
- Modify: `web/src/map.ts`
- Modify: `web/src/main.ts`
- Modify: `web/src/detail.ts` — emits `var(--k-…)` into `heading()`
- Modify: `web/src/search.ts` — emits `var(--k-…)` into the result badge
- Test: `web/src/levels.test.ts` (create)

**Interfaces:**
- Consumes: `Theme` from Task 1.
- Produces: `interface ThemeColour { light: string; dark: string }`; `LevelStyle.colour: ThemeColour`; `LevelStyle.cssVariable: string`; `colourFor(style: LevelStyle, theme: Theme): string`; `matchByView<T>(view: MapView, pick: (s: LevelStyle) => T, fallback: T): unknown[]` (unchanged signature); `registerRiskPatterns(map: MapLibreMap, theme: Theme): void`; `installOverlays(map: MapLibreMap, theme: Theme): MapHandles`; `MapHandles.setTheme(theme: Theme): void`.

**Amended after implementation found a gap.** `style.colour` has **five** consumers, not
three: `detail.ts:87-88` and `search.ts:69` were missed. They split by whether the consumer
can read CSS.

*Cannot read CSS, so they take a `Theme`:* `map.ts` (four paint sites) and `patterns.ts`
(canvas draw).

*Ends up in CSS anyway, so it takes no `Theme`:* `main.ts` `renderLegend`, `search.ts`
`describeResult`, and `detail.ts` `heading()` all funnel into the `--level-colour` custom
property. These emit **`var(--k-…)`**, not a hex, and CSS resolves the theme. Consequently
the `activeTheme` / `currentTheme()` placeholder that an earlier draft of this task added to
`main.ts` is **not** wanted — do not add it, and Task 8 no longer has to replace it.

Add `cssVariable` to every style: `low: "--k-low"`, `watch: "--k-watch"`, `high: "--k-high"`,
`confirmed: "--k-flood"`, `floods-first: "--k-first"`, `floods-heavy: "--k-heavy"`,
`usually-dry: "--k-dry"`. The three DOM consumers then set
`` `var(${style.cssVariable})` `` where they previously set `style.colour`.

- [ ] **Step 1: Write the failing test**

Create `web/src/levels.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd web && npm test
```

Expected: FAIL — `colourFor` is not exported from `./levels.ts`.

- [ ] **Step 3: Change the type and the ramp in `levels.ts`**

Add near the top of `web/src/levels.ts`, after the existing imports:

```ts
import type { Theme } from "./theme.ts";

/**
 * A ramp colour in both themes.
 *
 * The light side is not an inversion of the dark one. Each keeps the ordering
 * and the meaning but drops to hues that survive on its own ground, because a
 * colour tuned to glow on asphalt goes muddy on paper and vice versa.
 */
export interface ThemeColour {
  light: string;
  dark: string;
}

export function colourFor(style: LevelStyle, theme: Theme): string {
  return style.colour[theme];
}
```

In `interface LevelStyle`, change the `colour` field:

```ts
  /**
   * Colour-blind-distinguishable by lightness as well as hue, so the ramp
   * still reads as an ordering under deuteranopia or in direct sun.
   */
  colour: ThemeColour;
```

Replace the four `colour:` lines in `LEVEL_STYLES` with:

```ts
    // low
    colour: { light: "#8fb0c4", dark: "#5b8ca6" },
    // watch
    colour: { light: "#e0a511", dark: "#ffc53d" },
    // high
    colour: { light: "#e35d18", dark: "#ff7a1f" },
    // confirmed
    colour: { light: "#c8261a", dark: "#ff4530" },
```

Replace the three `colour:` lines in `TERRAIN_STYLES` with:

```ts
    // floods-first
    colour: { light: "#7c5ea6", dark: "#9a7bd6" },
    // floods-heavy
    colour: { light: "#a291bf", dark: "#6b5896" },
    // usually-dry
    colour: { light: "#ccd4d7", dark: "#2a3a45" },
```

- [ ] **Step 4: Run the test and confirm it passes, then fix the call sites**

```bash
cd web && npm test
```

Expected: `levels` tests PASS. Then:

```bash
npm run typecheck
```

Expected: FAIL in `patterns.ts`, `map.ts` and `main.ts` — `Type 'ThemeColour' is not assignable to type 'string'`. That list is the complete set of consumers.

- [ ] **Step 5: Thread the theme through `patterns.ts`**

In `web/src/patterns.ts`, change the import and the exported function:

```ts
import { LEVEL_STYLES, RISK_LEVELS, TERRAIN_BANDS, TERRAIN_STYLES, colourFor, type LevelStyle } from "./levels.ts";
import type { Theme } from "./theme.ts";
```

```ts
/**
 * Patterns are registered images, not paint. A theme change has to redraw and
 * re-register them; repainting alone leaves the old theme's colour baked into
 * the texture while the flat fill underneath moves, which reads as a rendering
 * fault rather than a theme.
 */
export function registerRiskPatterns(map: MapLibreMap, theme: Theme): void {
```

Inside that function, change the draw call:

```ts
    const image = draw(kind, colourFor(style, theme));
```

- [ ] **Step 6: Thread the theme through `map.ts`**

In `web/src/map.ts`, extend the import:

```ts
import { colourFor, matchByView, type MapView } from "./levels.ts";
import type { Theme } from "./theme.ts";
```

Change `installOverlays` to take and remember the theme:

```ts
export function installOverlays(map: MapLibreMap, theme: Theme): MapHandles {
  let activeTheme: Theme = theme;
  let currentView: MapView = "now";
  registerRiskPatterns(map, activeTheme);
```

`currentView` is needed by `setTheme` below, which has to repaint into whichever
view is on screen rather than resetting to `now`.

Replace both `matchByView("now", (s) => s.colour, "#2b83ba")` occurrences (the `fill-color` at the fill layer and the `line-color` at the outline layer) with:

```ts
          "fill-color": matchByView("now", (s) => colourFor(s, activeTheme), "#5b8ca6") as never,
```

```ts
          "line-color": matchByView("now", (s) => colourFor(s, activeTheme), "#5b8ca6") as never,
```

In `applyView`, take the theme as a parameter and use it:

```ts
function applyView(map: MapLibreMap, view: MapView, theme: Theme): void {
  if (!map.getLayer(RISK_LAYERS.fill)) return;

  map.setPaintProperty(
    RISK_LAYERS.fill,
    "fill-color",
    matchByView(view, (s) => colourFor(s, theme), "#5b8ca6") as never,
  );
```

and likewise the `line-color` `setPaintProperty` call in the same function.

Update the returned `MapHandles` so `setView` passes the remembered theme and a new `setTheme` exists. Add to the `MapHandles` interface:

```ts
  /** Recolour the overlay in place. Patterns are re-registered, not repainted. */
  setTheme(theme: Theme): void;
```

and in the returned object:

```ts
    setView: (view: MapView) => {
      currentView = view;
      applyView(map, view, activeTheme);
    },
    setTheme: (next: Theme) => {
      activeTheme = next;
      registerRiskPatterns(map, activeTheme);
      applyView(map, currentView, activeTheme);
    },
```

- [ ] **Step 7: Point the three DOM consumers at the token**

None of these takes a `Theme`. They name a variable and let CSS decide, which is why an
open sheet cannot hold a stale colour across a switch.

`main.ts`, in `renderLegend` (around line 157):

```ts
    swatch.style.setProperty("--level-colour", `var(${style.cssVariable})`);
```

`search.ts`, in `describeResult` (around line 69):

```ts
  return { text: style.label, tone: "level", colour: `var(${style.cssVariable})`, level: result.level };
```

`detail.ts` (around lines 87-88) — pass the variable reference through to `heading()`,
whose `colour: string` parameter needs no signature change:

```ts
        ? this.heading(style.label, `var(${style.cssVariable})`, detail.susceptibility, "Terrain score")
        : this.heading(style.label, `var(${style.cssVariable})`, detail.score, "Risk score"),
```

Then update the `installOverlays` call site in `main.ts` to pass a theme. Until Task 8
wires the real value, pass the literal `"dark"` at that one call site — do **not** add a
module-level `activeTheme` or a `currentTheme()` accessor.

- [ ] **Step 8: Verify everything is green**

```bash
cd web && npm test && npm run typecheck && npm run build
```

Expected: all tests pass, typecheck clean, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src/levels.ts web/src/levels.test.ts web/src/patterns.ts web/src/map.ts web/src/main.ts web/src/detail.ts web/src/search.ts
git commit -m "Give the risk ramp a light and a dark pair"
```

---

### Task 3: Self-hosted font subsets

**Files:**
- Create: `web/public/fonts/source-serif-4.woff2`
- Create: `web/public/fonts/atkinson-400.woff2`
- Create: `web/public/fonts/atkinson-700.woff2`
- Modify: `web/index.html`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS families `"Source Serif 4"` and `"Atkinson Hyperlegible Next"`, available to every later task.

- [ ] **Step 1: Copy the already-subsetted files into the app**

The Latin subsets were prepared during design and live in the gitignored preview directory. Copy them into the app's public assets:

```bash
cd /c/Users/PC/Desktop/AFW
mkdir -p web/public/fonts
cp .design-preview/fonts/source-serif-4.woff2 web/public/fonts/
cp .design-preview/fonts/atkinson-400.woff2 web/public/fonts/
cp .design-preview/fonts/atkinson-700.woff2 web/public/fonts/
ls -l web/public/fonts/ | awk '{print $5, $9}'
```

Expected: `50824 source-serif-4.woff2`, `12096 atkinson-400.woff2`, `12732 atkinson-700.woff2` — 76 KB total.

If `.design-preview/` is gone, regenerate them:

```bash
npm install --no-save @fontsource-variable/source-serif-4 @fontsource/atkinson-hyperlegible-next
cp node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2 web/public/fonts/source-serif-4.woff2
cp node_modules/@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-400-normal.woff2 web/public/fonts/atkinson-400.woff2
cp node_modules/@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff2 web/public/fonts/atkinson-700.woff2
```

- [ ] **Step 2: Declare the faces**

**Corrected.** An earlier draft of this step put the `@font-face` block *above* the
existing `@import "maplibre-gl/dist/maplibre-gl.css";` and justified it with a backwards
reading of the spec. CSS requires `@import` to come **first** — before every rule except
`@charset` and `@layer` — so `@font-face` above it invalidates the import. Vite happens to
inline the import at build time, which hides the mistake in production, but the source
should not depend on a bundler to rescue invalid CSS.

Put the `@font-face` block **immediately below** the existing `@import` line:

```css
/*
 * Self-hosted Latin subsets, 76 KB total, served from this distribution behind
 * the same long cache as everything else. Declared below the `@import` above,
 * because CSS requires `@import` to precede every rule but `@charset`/`@layer`.
 *
 * This supersedes the system-fonts-only rule in CLAUDE.md, under conditions:
 * `swap` plus a metric-ish system fallback means text paints immediately in a
 * fallback and the webfont never blocks. If a throttled-3G measurement shows
 * first contentful paint regressing, revert to the fallback stacks alone -- the
 * type scale carries more of the hierarchy here than the typeface does.
 */
@font-face {
  font-family: "Source Serif 4";
  src: url("/fonts/source-serif-4.woff2") format("woff2-variations");
  font-weight: 200 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Atkinson Hyperlegible Next";
  src: url("/fonts/atkinson-400.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Atkinson Hyperlegible Next";
  src: url("/fonts/atkinson-700.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 3: Preload the two faces that paint first**

In `web/index.html`, inside `<head>` immediately before the stylesheet `<link>`:

```html
    <!-- The body face and the headline face both appear above the fold. The
         third weight is not preloaded: it is only used by the legend, which
         renders after the first risk response. -->
    <link rel="preload" href="/fonts/atkinson-400.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="/fonts/source-serif-4.woff2" as="font" type="font/woff2" crossorigin />
```

- [ ] **Step 4: Verify the fonts load**

```bash
cd web && npm run dev
```

Open `http://localhost:5173`, then in the browser console:

```js
document.fonts.check('16px "Atkinson Hyperlegible Next"') &&
document.fonts.check('16px "Source Serif 4"')
```

Expected: `true`. Also confirm the Network tab shows all requested font files returning 200 and no request to any third-party host.

- [ ] **Step 5: Commit**

```bash
git add web/public/fonts web/index.html web/src/styles.css
git commit -m "Self-host Source Serif 4 and Atkinson Hyperlegible Next subsets"
```

---

### Task 4: Restructure the markup

The page will look wrong after this task and correct after Task 5. That is expected — this task's gate is that **every selector the TypeScript depends on still resolves**, because they are all non-null-asserted `querySelector` calls that TypeScript cannot check.

**Files:**
- Modify: `web/index.html`
- Create: `web/src/shell.test.ts`
- Create: `docs/evidence/verify-layout.js`

**Interfaces:**
- Consumes: nothing.
- Produces: DOM structure `.stage > #map`, overlays `.ov-read`, `.ov-tools`, `.rail`, `.ov-seg`, `.ov-dock`, `.ov-legal`; a theme button `#theme-toggle` with `.tool__moon` / `.tool__sun` children, consumed by Task 8.

- [ ] **Step 1: Write the DOM contract test**

`main.ts` and the sheet modules reach into the DOM with 26 `querySelector(...)!`
calls. The non-null assertion means TypeScript cannot catch a renamed or dropped
node — it fails at runtime, in the browser, as a blank screen. A static test over
`index.html` catches it in `npm test` instead, and keeps catching it.

Create `web/src/shell.test.ts` (this is the shipped file, copied verbatim — four assertions in it were rewritten during review after each passed on markup that had moved elsewhere, so `scopeOf` now takes both bounds at once):

```ts
/**
 * The DOM contract between index.html and the TypeScript that reaches into it.
 *
 * Every selector below is used with a non-null assertion somewhere in the app,
 * so a missing node is not a type error -- it is a blank screen. Restructuring
 * the shell is exactly when one gets dropped, which is why this is a test and
 * not a checklist.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/**
 * The markup between an opening anchor and its closing tag.
 *
 * Every structural check here needs BOTH bounds. Four assertions in this file
 * have shipped with a start and no end, each passing happily on markup that had
 * moved elsewhere -- so the bound is taken once, here, rather than remembered
 * correctly at each call site.
 */
function scopeOf(openAnchor: string, closeTag: string): string {
  const start = HTML.indexOf(openAnchor);
  assert.notEqual(start, -1, `index.html no longer contains ${openAnchor}`);
  const end = HTML.indexOf(closeTag, start);
  assert.notEqual(end, -1, `${openAnchor} is not closed by ${closeTag}`);
  return HTML.slice(start, end);
}

/** ids reached for by id. */
const IDS = [
  "status", "tagline", "map", "legend", "search", "search-input", "search-results",
  "language-select", "view-reason", "route-button", "route-prompt", "route-cancel",
  "report-button", "detail-sheet", "route-sheet", "report-sheet", "theme-toggle",
];

/** class tokens reached for by class. */
const CLASSES = [
  "search__input", "search__clear", "search__results", "language",
  "view-bar", "view-toggle__option", "route-prompt__text",
  "report-button__label", "sheet__body", "sheet__close", "disclaimer",
  "rail__cap",
];

describe("shell DOM contract", () => {
  for (const id of IDS) {
    it(`keeps #${id}`, () => {
      assert.ok(
        new RegExp(`id="${id}"`).test(HTML),
        `index.html no longer defines id="${id}" -- main.ts asserts it exists`,
      );
    });
  }

  for (const cls of CLASSES) {
    it(`keeps .${cls}`, () => {
      // \\b (not \b): inside a template literal, an unescaped \b is the
      // backspace-character escape, not a regex word-boundary token -- it
      // would compile to a pattern that can never match anything in HTML.
      assert.ok(
        new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`).test(HTML),
        `index.html no longer defines .${cls} -- the app asserts it exists`,
      );
    });
  }

  it("keeps a data-view button for each of the three views", () => {
    for (const view of ["now", "later", "terrain"]) {
      assert.ok(
        new RegExp(`data-view="${view}"`).test(HTML),
        `missing data-view="${view}"`,
      );
    }
  });

  it("keeps .report-button__label inside #report-button", () => {
    const scope = scopeOf('id="report-button"', "</button>");
    assert.ok(
      scope.includes("report-button__label"),
      "main.ts selects '#report-button .report-button__label'; it must be a descendant",
    );
  });

  it("keeps a body and close button inside every sheet", () => {
    for (const id of ["detail-sheet", "route-sheet", "report-sheet"]) {
      const start = HTML.indexOf(`id="${id}"`);
      assert.notEqual(start, -1, `missing #${id}`);
      // Bound the slice to this sheet's own block. A fixed-size window bled into
      // the NEXT sheet, so a sheet that had lost its body still passed on its
      // neighbour's markup -- the assertion protected only the last sheet.
      const next = HTML.indexOf('id="', start + 1);
      const scope = HTML.slice(start, next === -1 ? HTML.length : next);
      assert.ok(scope.includes("sheet__body"), `#${id} has no .sheet__body`);
      assert.ok(scope.includes("sheet__close"), `#${id} has no .sheet__close`);
    }
  });

  it("keeps rail__cap a sibling of #legend, not a child", () => {
    // renderLegend calls replaceChildren on #legend, so a cap nested inside it
    // would be wiped on the first risk response rather than merely misplaced.
    const legend = scopeOf('id="legend"', "</section>");
    assert.ok(
      !legend.includes("rail__cap"),
      "rail__cap must be a sibling of #legend -- replaceChildren would wipe it",
    );

    const rail = scopeOf('class="rail"', "</div>");
    assert.ok(rail.includes('id="legend"'), "#legend must sit inside .rail");
    assert.ok(rail.includes("rail__cap"), "rail__cap must sit inside .rail");
    assert.ok(
      rail.indexOf("rail__cap") > rail.indexOf('id="legend"'),
      "rail__cap must come after #legend inside .rail",
    );
  });

  it("keeps the disclaimer pointing at NADMO and GMet", () => {
    // Scoped to the element, not the file: matching anywhere would still pass
    // if this text survived only in a comment. It is a safety requirement.
    const scope = scopeOf('class="ov ov-legal disclaimer"', "</footer>");
    assert.match(scope, /NADMO/, "the disclaimer must name NADMO");
    assert.match(scope, /Meteorological/, "the disclaimer must name GMet");
    assert.match(
      scope,
      /not an official warning service/i,
      "the disclaimer must say this is not an official warning service",
    );
  });
});
```

**Corrected after review.** The first draft of the sheet check sliced a fixed
600-character window from each `id="..."`. Each sheet block is only about 290
characters, so the window ran into the NEXT sheet and a sheet that had lost its
body still passed on its neighbour's markup — only the last sheet was ever
protected. Proven by gutting `route-sheet` and watching the old test pass. Bound
every such slice to its own element. The sibling test below was added at the same
time: `renderLegend` calls `replaceChildren` on `#legend`, so a cap nested inside
it would vanish on the first risk response.

**Corrected after review.** The first draft of the sheet check sliced a fixed
600-character window from each `id="..."`. Each sheet block is only about 290
characters, so the window ran into the NEXT sheet and a sheet that had lost its
body still passed on its neighbour's markup — only the last sheet was ever
protected. Proven by gutting `route-sheet` and watching the old test pass. Bound
every such slice to its own element. The sibling test below was added at the same
time: `renderLegend` calls `replaceChildren` on `#legend`, so a cap nested inside
it would vanish on the first risk response.

Run it against the CURRENT `index.html` before changing anything:

```bash
cd web && npm test
```

Expected: `#theme-toggle` FAILS (it does not exist yet) and everything else passes.
That failure is your RED — it proves the test can actually detect a missing node.

If any other check fails, the test is wrong rather than the markup. Say so and
fix the test before going further: a contract test that fails for its own
reasons proves nothing about the contract it claims to protect.

If other checks fail too, the test is wrong rather than the markup. Say so and fix
the test first: a contract test that fails for its own reasons proves nothing
about the contract.

- [ ] **Step 2: Write the browser contract check**

Create `docs/evidence/verify-layout.js`. This is pasted into the browser console — it is not part of the bundle:

```js
/*
 * Layout and DOM-contract verification for Accra Flood Watch.
 *
 * Paste into the devtools console on a 390x844 viewport. Everything here was
 * a real bug at some point during the redesign, and three of them were
 * invisible in a screenshot.
 */
(() => {
  const SELECTORS = [
    "#status", "#tagline", "#map", "#legend", "#search", ".search__input",
    ".search__clear", ".search__results", ".language", "#language-select",
    ".view-bar", "#view-reason", ".view-toggle__option[data-view]",
    "#route-button", "#route-prompt", ".route-prompt__text", "#route-cancel",
    "#report-button", "#report-button .report-button__label",
    "#detail-sheet", "#route-sheet", "#report-sheet",
    "#detail-sheet .sheet__body", "#detail-sheet .sheet__close",
    ".disclaimer strong", "#theme-toggle",
  ];
  const missing = SELECTORS.filter((s) => !document.querySelector(s));

  const OVERLAYS = [".ov-read", ".ov-tools", ".rail", ".ov-seg", ".ov-dock", ".ov-legal"];
  const boxes = OVERLAYS
    .map((s) => [s, document.querySelector(s)])
    .filter(([, el]) => el && getComputedStyle(el).display !== "none")
    .map(([s, el]) => [s, el.getBoundingClientRect()]);

  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [an, a] = boxes[i], [bn, b] = boxes[j];
      if (!(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)) {
        overlaps.push(`${an} x ${bn}`);
      }
    }
  }

  const legal = document.querySelector(".ov-legal")?.getBoundingClientRect();
  const report = {
    missingSelectors: missing,
    overlaps,
    pageScrolls: document.body.scrollHeight > window.innerHeight + 1,
    scrollHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight,
    disclaimerFullyVisible: legal ? legal.bottom <= window.innerHeight + 1 : false,
  };
  console.table(report);
  const ok = !missing.length && !overlaps.length && !report.pageScrolls && report.disclaimerFullyVisible;
  console.log(ok ? "PASS" : "FAIL", report);
  return report;
})();
```

- [ ] **Step 3: Replace the body of `web/index.html`**

Keep `<head>` exactly as Task 3 left it. Replace everything from `<body>` to `</body>` with:

```html
  <body>
    <div class="app">
      <main class="stage">
        <div id="map" class="map" role="application" aria-label="Flood risk map of the pilot area">
          <noscript>
            <p class="noscript">
              Accra Flood Watch needs JavaScript to draw the flood risk map. For official
              warnings, contact NADMO or the Ghana Meteorological Agency.
            </p>
          </noscript>
        </div>

        <!-- The reading card. It answers in a sentence before it answers in
             colour, so somebody who glances once and leaves still got the
             answer. #status and #tagline keep their ids and their writers in
             main.ts; only their position and styling change. -->
        <div class="ov ov-read">
          <p id="view-reason" class="ov-read__txt" role="status" aria-live="polite"></p>
          <p class="ov-read__meta">
            <span id="status" class="status status--pending">Loading flood risk…</span>
            <span id="tagline" class="tagline">Accra</span>
          </p>
        </div>

        <!-- Search and the theme switch. Both are chosen deliberately rather
             than under pressure, which is why they are here and the report
             button is not. -->
        <div class="ov ov-tools">
          <form id="search" class="search" role="search" autocomplete="off">
            <label class="search__label" for="search-input">Search for a place</label>
            <div class="search__field">
              <span class="search__icon" aria-hidden="true">⌕</span>
              <input
                id="search-input"
                class="search__input"
                type="search"
                name="q"
                enterkeyhint="search"
                placeholder="Street or landmark…"
                aria-describedby="search-results"
              />
              <button type="button" class="search__clear" aria-label="Clear search" hidden>✕</button>
            </div>
            <div id="search-results" class="search__results" role="region" aria-live="polite" hidden></div>
          </form>

          <button id="theme-toggle" class="tool" type="button" aria-label="Switch to light theme">
            <svg class="tool__moon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>
            <svg class="tool__sun" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>
          </button>

          <div class="language">
            <label class="search__label" for="language-select">Language</label>
            <select id="language-select" class="language__select"></select>
          </div>
        </div>

        <!-- The gauge rail. #legend is a CHILD, because renderLegend calls
             replaceChildren on it and would wipe any sibling content placed
             inside. The cap lives outside it and therefore survives. -->
        <div class="rail">
          <section id="legend" aria-label="What the colours and patterns mean"></section>
          <p class="rail__cap">worst<br />in view</p>
        </div>

        <div class="ov ov-seg view-bar">
          <div class="view-toggle" role="group" aria-label="What the map shows">
            <button type="button" class="view-toggle__option seg" data-view="now" aria-pressed="true">Right now</button>
            <button type="button" class="view-toggle__option seg" data-view="later" aria-pressed="false">Later today</button>
            <button type="button" class="view-toggle__option seg" data-view="terrain" aria-pressed="false">When it rains</button>
          </div>
        </div>

        <div id="route-prompt" class="route-prompt" role="status" aria-live="polite" hidden>
          <p class="route-prompt__text">Tap where you are going.</p>
          <button type="button" id="route-cancel" class="route-prompt__cancel">Cancel</button>
        </div>

        <div class="ov ov-dock">
          <button id="route-button" type="button" class="route-button btn">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 20c0-6 3-9 7-9s7 2 7-3"/><circle cx="5" cy="20" r="2"/><path d="m16 5 4 3-4 3"/></svg>
            <span>Safe route</span>
          </button>
          <button id="report-button" type="button" class="report-button btn btn--primary">
            <span class="report-button__icon" aria-hidden="true">＋</span>
            <span class="report-button__label">Report water</span>
          </button>
        </div>

        <footer class="ov ov-legal disclaimer">
          <p>
            <strong>This is a community information tool, not an official warning service.</strong>
            For official warnings consult
            <abbr title="National Disaster Management Organisation">NADMO</abbr> and the Ghana
            Meteorological Agency.
          </p>
        </footer>
      </main>
    </div>

    <div id="detail-sheet" class="sheet" role="dialog" aria-modal="false" aria-label="Flood risk detail" hidden>
      <div class="sheet__panel">
        <button type="button" class="sheet__close" aria-label="Close">Close</button>
        <div class="sheet__body"></div>
      </div>
    </div>

    <div id="route-sheet" class="sheet" role="dialog" aria-modal="true" aria-label="Safe route" hidden>
      <div class="sheet__panel">
        <button type="button" class="sheet__close" aria-label="Close">Close</button>
        <div class="sheet__body"></div>
      </div>
    </div>

    <div id="report-sheet" class="sheet" role="dialog" aria-modal="true" aria-label="Report water depth" hidden>
      <div class="sheet__panel">
        <button type="button" class="sheet__close" aria-label="Close">Close</button>
        <div class="sheet__body"></div>
      </div>
    </div>

    <script type="module" src="/src/main.ts"></script>
  </body>
```

Note two deliberate carry-overs: `.view-bar` stays as a class on the segment overlay because `main.ts` toggles `view-bar--overridden` on it, and `#view-reason` moves into the reading card because it is the sentence the card exists to show.

- [ ] **Step 4: Run the contract checks**

```bash
cd web && npm run dev
```

First the committable one:

```bash
cd web && npm test
```

Expected: the whole `shell DOM contract` suite passes, including `#theme-toggle`.
This is the gate for this task.

Then, if a browser is available, paste `docs/evidence/verify-layout.js` into the
console at 390×844 for the layout half. Expected at this stage:
`missingSelectors: []`. The `overlaps` and `pageScrolls` fields will still fail — Task 6 fixes those. If any selector is missing, fix the markup before continuing; a missing selector is a runtime crash in `main.ts`.

- [ ] **Step 5: Confirm the app still functions**

With the dev server running, click a risk cell, open the report sheet, and switch views. All three must work, however ugly the page looks.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/src/shell.test.ts docs/evidence/verify-layout.js
git commit -m "Restructure the shell as a map stage with floating overlays"
```

---

### Task 5: Token system and component styling

**Files:**
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: the markup from Task 4, the font families from Task 3.
- Produces: CSS custom properties `--ground --surface --edge --ink --ink-2 --lift --live --legal-bg --legal-ink --legal-strong --btn-bg --cta-bg --cta-ink --seg-bg --seg-on-bg --seg-on-ink --marker`, defined for `:root` and `:root[data-theme="light"]`; consumed by Task 8, which sets `data-theme` on `<html>`.

- [ ] **Step 1: Define the token pairs**

Replace the existing `:root { … }` block in `web/src/styles.css` with:

```css
/*
 * Dark is the base because it is the condition this app is opened in. Light is
 * the pair, not an inversion: the ramp keeps its meaning but drops to hues that
 * survive on paper, and the ground stays cool rather than white so a low-risk
 * cell still reads as an overlay that loaded rather than as blank map. "No
 * data" and "low risk" must never look the same.
 */
:root {
  --ground: #0a1218;
  --surface: rgba(22, 34, 43, 0.93);
  --surface-solid: #16222b;
  --edge: rgba(91, 140, 166, 0.3);
  --ink: #e8f1f5;
  --ink-2: #9db8c6;
  --lift: 0 8px 26px rgba(0, 0, 0, 0.55);
  --live: #5fe3a1;
  --marker: #ffc53d;
  --legal-bg: #061015;
  --legal-ink: #8fa8b6;
  --legal-strong: #cfe0e8;
  --btn-bg: #16222b;
  --cta-bg: #e8f1f5;
  --cta-ink: #06131b;
  --seg-bg: rgba(22, 34, 43, 0.9);
  --seg-on-bg: #334d5c;
  --seg-on-ink: #e8f1f5;

  /* The risk ramp. These are read by the legend, the search badges and the
     detail sheet, which emit `var(--k-…)` rather than a hex so CSS resolves
     the theme for them. The same values live in levels.ts for the map, which
     cannot read CSS -- contrast.test.ts asserts the two agree. */
  --k-low: #5b8ca6;
  --k-watch: #ffc53d;
  --k-high: #ff7a1f;
  --k-flood: #ff4530;
  --k-first: #9a7bd6;
  --k-heavy: #6b5896;
  --k-dry: #2a3a45;

  --radius: 12px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

:root[data-theme="light"] {
  --ground: #e6ecef;
  --surface: rgba(255, 255, 255, 0.96);
  --surface-solid: #ffffff;
  --edge: rgba(14, 32, 41, 0.14);
  --ink: #0e2029;
  --ink-2: #4c6672;
  --lift: 0 8px 26px rgba(14, 32, 41, 0.18);
  --live: #1a7f4f;
  --marker: #b8800a;
  --legal-bg: #0e2029;
  --legal-ink: #a3b6bf;
  --legal-strong: #eef3f5;
  --btn-bg: #ffffff;
  --cta-bg: #0e2029;
  --cta-ink: #f2f7f9;
  --seg-bg: rgba(255, 255, 255, 0.95);
  --seg-on-bg: #14323e;
  --seg-on-ink: #f2f7f9;

  --k-low: #8fb0c4;
  --k-watch: #e0a511;
  --k-high: #e35d18;
  --k-flood: #c8261a;
  --k-first: #7c5ea6;
  --k-heavy: #a291bf;
  --k-dry: #ccd4d7;
}
```

- [ ] **Step 2: Restyle the body and the shell**

```css
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
}

.app { height: 100%; }

/* The map is the stage. It takes the whole screen; the old `min-height: 35vh`
   floor and the arithmetic that maintained it are gone, because overlays no
   longer participate in flow and so can no longer push the page into scroll. */
.stage { position: relative; height: 100%; overflow: hidden; }
.map { position: absolute; inset: 0; background: var(--ground); }
```

- [ ] **Step 3: Style the reading card, the tools and the rail**

```css
.ov { position: absolute; z-index: 2; }

.ov-read {
  background: var(--surface);
  border: 1px solid var(--edge);
  border-radius: 13px;
  padding: 13px 15px 12px;
  box-shadow: var(--lift);
  display: grid;
  gap: 7px;
}

/* Serif on a dark ground goes fragile at book weight, so this runs heavier
   than the same face would on paper. It is allowed exactly one job. */
.ov-read__txt {
  margin: 0;
  font-family: "Source Serif 4", Georgia, serif;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.008em;
  color: var(--ink);
  text-wrap: balance;
}

.ov-read__meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}

/* Freshness keeps a word as well as a colour, but no longer a pill: the
   saturated palette belongs to risk alone. */
.status { display: inline-flex; align-items: center; gap: 6px; }
.status::before {
  content: "";
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--live); flex: none;
}
.status--warn::before, .status--error::before { background: var(--marker); }
.tagline { color: var(--ink-2); }

.tool {
  width: 46px; height: 46px; border-radius: var(--radius);
  background: var(--surface); border: 1px solid var(--edge); color: var(--ink);
  box-shadow: var(--lift);
  display: grid; place-items: center; cursor: pointer; padding: 0;
}
.tool svg { display: block; }
/* These must out-specify `.tool svg`, or both icons render at once. */
.tool .tool__sun { display: none; }
:root[data-theme="light"] .tool .tool__moon { display: none; }
:root[data-theme="light"] .tool .tool__sun { display: block; }

/* The rail is read, not pressed, so it sits where the eye lands rather than
   where the thumb reaches. That also frees the top-right for the controls. */
.rail {
  position: absolute; z-index: 3;
  top: 50%; transform: translateY(-50%); right: 12px; width: 62px;
  background: var(--surface); border: 1px solid var(--edge);
  border-radius: 10px; padding: 7px 5px;
  box-shadow: var(--lift);
}
.rail__cap {
  margin: 4px 0 0; padding-top: 5px;
  border-top: 1px solid var(--edge);
  font-size: 10px; color: var(--ink-2); text-align: center; line-height: 1.25;
}
```

- [ ] **Step 4: Restyle the legend as rail ticks**

`renderLegend` emits `ul.legend__list > li.legend__item > span.legend__swatch + span.legend__text > strong + span`. The rail shows the swatch and the `strong`; the `meaning` moves to the detail sheet, where there is room to read it.

```css
.legend__list { list-style: none; margin: 0; padding: 0; }
.legend__item {
  display: grid; grid-template-columns: 13px 1fr;
  align-items: center; gap: 5px; padding: 5px 2px;
}
.legend__swatch {
  width: 13px; height: 13px; border-radius: 3px;
  background: var(--level-colour);
}
.legend__text { font-size: 10px; line-height: 1.2; color: var(--ink-2); }
/* The one-line meaning is still in the DOM for screen readers; the rail has no
   room for it and the detail sheet says it properly. */
.legend__text span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.legend__text strong { font-weight: 700; }
```

- [ ] **Step 5: Restyle segments, dock and disclaimer**

```css
.view-toggle { display: flex; }
.seg {
  border: 0; font: inherit; cursor: pointer;
  background: var(--seg-bg); color: var(--ink-2);
  padding: 9px 10px; font-size: 12px;
  border-right: 1px solid var(--edge);
}
.seg:first-child { border-radius: 10px 0 0 10px; }
.seg:last-child { border-radius: 0 10px 10px 0; border-right: 0; }
.seg[aria-pressed="true"] { background: var(--seg-on-bg); color: var(--seg-on-ink); font-weight: 700; }

.btn {
  border: 0; font: inherit; cursor: pointer;
  display: flex; align-items: center; gap: 8px;
  background: var(--btn-bg); color: var(--ink);
  border: 1px solid var(--edge);
  padding: 12px 15px; border-radius: 11px;
  font-size: 14px; font-weight: 700;
  box-shadow: var(--lift);
}
/* Never a ramp colour. Red here means Flooded now, and this is a neutral
   action. */
.btn--primary { background: var(--cta-bg); color: var(--cta-ink); border-color: var(--cta-bg); }

.ov-legal {
  background: var(--legal-bg); color: var(--legal-ink);
  font-size: 12px; line-height: 1.35;
}
.ov-legal p { margin: 0; }
.ov-legal strong { color: var(--legal-strong); font-weight: 700; }
```

Then delete the now-dead rules from the old layout: `.masthead`, `.masthead__title`, `.view-bar__reason`, `.legend` as a band, `.actions`, and the `--brand` / `--danger` / `--paper` / `--ok*` / `--warn*` / `--error*` / `--pending*` custom properties. Search for each before deleting to confirm nothing else references it.

- [ ] **Step 6: Assert both themes are legible**

The preview shipped six genuine contrast failures that were invisible until
measured. This reads the real stylesheet rather than a copy of the values, so it
cannot drift out of step with what ships.

Create `web/src/contrast.test.ts`:

```ts
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
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * (n & 255)
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

describe("theme contrast", () => {
  const dark = block(":root");
  const light = { ...dark, ...block(':root[data-theme="light"]') };

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

  it("defines every token in light that it defines in dark", () => {
    const missing = Object.keys(dark).filter((k) => !(k in light));
    assert.deepEqual(missing, [], `tokens missing from the light theme: ${missing.join(", ")}`);
  });
});
```

Run it:

```bash
cd web && npm test
```

Expected: every pair PASSES. If one fails, darken the foreground token rather
than lightening the ground — the grounds carry the theme's identity.

- [ ] **Step 7: Clear the padding findings Task 4 could not answer**

After Task 4 restructured the markup, the design detector reported three
`cramped-padding` findings against `web/index.html`: children flush inside
`.map`, inside `.view-toggle`, and inside `.sheet__panel`. Those were premature,
not wrong — Task 4 was forbidden to touch the stylesheet, so the detector was
judging new markup against the old CSS. This task owns the CSS, so it owns them.

```bash
cd /c/Users/PC/Desktop/AFW
"C:/Users/PC/.claude/plugins/cache/impeccable/impeccable/4.3.1/skills/impeccable/scripts/impeccable" detect web/index.html --no-advisory
```

Each finding is either genuinely fixed by the new stylesheet or a container
whose children legitimately sit flush. Resolve every one, and say in your report
which of the two each was:

- `.map` — its only child is the `<noscript>` fallback. That paragraph needs real
  padding of its own; a full-bleed map container does not.
- `.view-toggle` — the segments carry their own `padding: 9px 10px`, so the group
  is a flush container by design.
- `.sheet__panel` — the sheets keep their existing treatment; confirm the body
  still has its inset and that the safe-area inset at the bottom survived.

Do not suppress a finding to clear it. If one is a genuine false positive, say so
in the report with the reason and leave it standing for the reviewer to judge.

- [ ] **Step 7: Verify nothing references a deleted token**

```bash
cd web && grep -nE "var\(--(brand|danger|paper|ok|ok-bg|warn|warn-bg|error|error-bg|pending|pending-bg|line|ink-soft)\)" src/styles.css
```

Expected: no output. Then:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add web/src/styles.css web/src/contrast.test.ts
git commit -m "Rebuild the stylesheet on light and dark token pairs"
```

---

### Task 6: Overlay geometry

The numbers here were measured, not chosen. Every one of them was an overlap at some point in the design preview.

**Files:**
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: Task 5's components.
- Produces: a layout that passes `verify-layout.js` with zero overlaps and no page scroll.

- [ ] **Step 1: Position the overlays**

```css
/*
 * Measured at 390x844 against the longest real copy in every view. The control
 * column clears the TALLEST state of the reading card, not the current one --
 * the terrain sentence runs to three lines and the tagline is allowed to wrap
 * beneath it.
 */
.ov-read  { top: 14px; left: 12px; right: 12px; }
.ov-tools { top: 156px; right: 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.ov-seg   { left: 12px; bottom: 64px; display: flex; }
.ov-dock  { right: 12px; bottom: 64px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.ov-legal { left: 0; right: 0; bottom: 0; padding: 8px 14px calc(8px + var(--safe-bottom)); }
```

- [ ] **Step 2: Collapse search to an icon until tapped**

The full field would take the width the reading card needs. It expands on focus.

```css
.search { position: relative; }
.search__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.search__field {
  display: flex; align-items: center; gap: 6px;
  width: 46px; height: 46px; padding: 0;
  border-radius: var(--radius);
  background: var(--surface); border: 1px solid var(--edge);
  box-shadow: var(--lift);
  overflow: hidden;
  transition: width 0.18s ease, padding 0.18s ease;
}
.search__icon { width: 46px; text-align: center; flex: none; color: var(--ink); font-size: 19px; }
.search__input {
  flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
  color: var(--ink); font: inherit; font-size: 15px; opacity: 0;
  transition: opacity 0.14s ease;
}
.search__field:focus-within {
  width: calc(100vw - 24px); padding-right: 8px;
}
.search__field:focus-within .search__input { opacity: 1; }
.search__results {
  position: absolute; top: 54px; right: 0; width: calc(100vw - 24px);
  background: var(--surface-solid); border: 1px solid var(--edge);
  border-radius: var(--radius); box-shadow: var(--lift);
  max-height: 50vh; overflow-y: auto;
}

@media (prefers-reduced-motion: reduce) {
  .search__field, .search__input { transition: none; }
}
```

- [ ] **Step 3: Give desktop a real layout**

```css
/* At laptop width the phone dock stranded at the bottom of a wide screen is
   the wrong answer. The rail becomes a column and the map takes the rest. */
@media (min-width: 900px) {
  .stage { display: grid; grid-template-columns: 344px 1fr; }
  .map { position: relative; inset: auto; grid-column: 2; }
  .ov, .rail {
    position: static; transform: none;
    grid-column: 1; width: auto; box-shadow: none;
  }
  .stage > .ov, .stage > .rail {
    grid-column: 1; margin: 0 22px;
  }
  .ov-legal { margin-bottom: 16px; }
}
```

- [ ] **Step 4: Verify the geometry**

```bash
cd web && npm run dev
```

At 390×844, paste `docs/evidence/verify-layout.js`. Expected:

```
missingSelectors: []
overlaps: []
pageScrolls: false
disclaimerFullyVisible: true
```

Then repeat at 1440×900 and confirm the disclaimer is still fully visible and nothing overlaps.

If `overlaps` is non-empty, read the pair it names and adjust that overlay's offset — do not adjust a neighbour's.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css
git commit -m "Position the overlays so none can collide or force a scroll"
```

---

### Task 7: Map padding for occluded chrome

Without this, a flown-to search result or shared pin lands under the reading card and looks like a broken search.

**Files:**
- Modify: `web/src/map.ts`

**Interfaces:**
- Consumes: the overlay geometry from Task 6.
- Produces: `export const MAP_PADDING: { top: number; bottom: number; left: number; right: number }`.

- [ ] **Step 1: Define the insets**

Add near the top of `web/src/map.ts`, below the layer constants:

```ts
/**
 * How much of the map each edge's chrome covers.
 *
 * Every camera move has to be told, or a pin flown to the centre lands under
 * the reading card and the feature looks broken rather than occluded. The
 * numbers mirror the overlay offsets in styles.css; if those change, these do.
 */
export const MAP_PADDING = { top: 150, bottom: 130, left: 16, right: 90 } as const;
```

- [ ] **Step 2: Apply it to every camera move**

Find each `easeTo`, `flyTo`, `fitBounds` and `jumpTo` call in `map.ts`:

```bash
cd web && grep -n "easeTo\|flyTo\|fitBounds\|jumpTo" src/map.ts
```

Add `padding: MAP_PADDING` to the options object of each one. For `fitBounds` the padding argument goes in the same options object.

- [ ] **Step 3: Verify a pin lands where it can be seen**

```bash
cd web && npm run dev
```

At 390×844, search for a street in the covered area and select a result. The pin and its detail must appear in the visible band between the reading card and the segments — not behind either.

- [ ] **Step 4: Commit**

```bash
git add web/src/map.ts
git commit -m "Tell the camera which edges the chrome covers"
```

---

### Task 8: Theme switching, end to end

The three layers — CSS tokens, basemap, risk ramp — must move together, or the result is a dark interface over a light map.

**Files:**
- Modify: `web/src/main.ts`
- Modify: `web/src/map.ts`

**Interfaces:**
- Consumes: `theme.ts` (Task 1), `colourFor` and `MapHandles.setTheme` (Task 2), `#theme-toggle` (Task 4), `data-theme` tokens (Task 5).
- Produces: nothing downstream.

**The real `MapHandles` methods are `setRisk(cells)`, `setReports(reports)`,
`setRoute(route | null)` and `setSearchPin(place | null)`** — not `setRiskCells`.
`setStyle` drops every source, so all four have to be re-pushed.

- [ ] **Step 1: Build the theme-aware style URL**

Add to `web/src/map.ts`:

```ts
/**
 * Amazon Location serves a dark variant of the same style from the same
 * endpoint. Verified against the live stack: `color-scheme=Light` is
 * byte-identical to omitting the parameter, and `Dark` returns a genuinely
 * different descriptor with the same 160 layers.
 *
 * `color-scheme` is already in the TileCachePolicy query-string whitelist in
 * template.yaml, so the two variants get separate cache keys instead of
 * colliding. This needs no backend or CloudFormation change.
 */
export function styleUrlForTheme(styleUrl: string, theme: Theme): string {
  const separator = styleUrl.includes("?") ? "&" : "?";
  return `${styleUrl}${separator}color-scheme=${theme === "dark" ? "Dark" : "Light"}`;
}
```

- [ ] **Step 2: Swap the basemap without losing the overlay or the camera**

Add to `web/src/map.ts`:

```ts
/**
 * `setStyle` drops every source AND every registered image, which is why
 * `installOverlays` has always been written to be callable twice. The camera
 * is captured and restored explicitly: setStyle only preserves it when it
 * judges the new style compatible, and relying on that is how a theme switch
 * silently recentres the map.
 */
export function applyBasemapTheme(
  map: MapLibreMap,
  styleUrl: string,
  theme: Theme,
  reinstall: () => void,
): void {
  const camera = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };

  map.once("styledata", () => {
    reinstall();
    map.jumpTo(camera);
  });

  map.setStyle(styleUrlForTheme(styleUrl, theme));
}
```

- [ ] **Step 3: Wire it up in `main.ts`**

Task 2 left no placeholder to replace (see its amendment note); the legend, search badges
and detail sheet already follow the theme through CSS. What is missing is the live value
for the map. Add the imports:

```ts
import { applyBasemapTheme, styleUrlForTheme } from "./map.ts";
import {
  nextChoice,
  readStoredChoice,
  resolveTheme,
  storeChoice,
  type Theme,
  type ThemeChoice,
} from "./theme.ts";
```

Add near the other module state:

```ts
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let themeChoice: ThemeChoice = readStoredChoice(window.localStorage);
let activeTheme: Theme = resolveTheme(themeChoice, darkQuery.matches);

function currentTheme(): Theme {
  return activeTheme;
}

/** Paint the interface. The map is a separate, heavier step. */
function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  toggle?.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
  // The theme-colour meta drives the browser chrome around the PWA; leaving it
  // on the old navy is the one place a stale colour is visible outside the app.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a1218" : "#e6ecef");
}
```

Set the theme before the map is created, so the first style fetched is already the right one. Change the `createMap` call:

```ts
  const map = createMap(
    elements.map,
    styleUrlForTheme(config.map.styleUrl, activeTheme),
    config.map.key,
    envelope,
    centre,
  );
```

and call `applyThemeToDocument(activeTheme);` immediately before it.

- [ ] **Step 4: Handle the switch and the system change**

Add after the map handles are available:

```ts
  const reinstallOverlays = (): void => {
    handles = installOverlays(map, activeTheme);
    handles.setView(activeView);
    // Re-push everything that was on screen. `setStyle` dropped every source,
    // and waiting for the next poll would leave the map blank for up to a
    // minute. The route matters most: somebody who just found a way around the
    // water must not lose it because they changed the colours.
    handles.setRisk(currentCells);
    handles.setReports(currentReports);
    handles.setRoute(currentRoute);
    handles.setSearchPin(currentPin);
  };

  const switchTheme = (theme: Theme): void => {
    activeTheme = theme;
    applyThemeToDocument(theme);
    renderLegend(activeView);
    applyBasemapTheme(map, config.map.styleUrl, theme, reinstallOverlays);
  };

  document.querySelector<HTMLButtonElement>("#theme-toggle")?.addEventListener("click", () => {
    themeChoice = nextChoice(activeTheme);
    storeChoice(window.localStorage, themeChoice);
    switchTheme(resolveTheme(themeChoice, darkQuery.matches));
  });

  // A user who has never chosen keeps following their phone, so an app left
  // open across dusk comes with it.
  darkQuery.addEventListener("change", (event) => {
    if (themeChoice !== "system") return;
    switchTheme(resolveTheme("system", event.matches));
  });
```

`currentCells` and `currentReports` are already module-level in `main.ts`. A
drawn route and a search pin are **not**, so add them beside the others near
line 80 and assign at each existing call site:

```ts
let currentRoute: DrawnRoute | null = null;
let currentPin: { longitude: number; latitude: number; title: string } | null = null;
```

Then change the four existing calls so the state is recorded as well as drawn:

```ts
// where the route is drawn or cleared
currentRoute = drawn;
handles?.setRoute(drawn);
```

```ts
// where the route is cleared
currentRoute = null;
handles?.setRoute(null);
```

```ts
// where a search result or shared place is pinned
currentPin = place;
handles?.setSearchPin(place);
```

```ts
// in the search onClear handler
currentPin = null;
handles?.setSearchPin(null);
```

Import `DrawnRoute` from wherever `map.ts` exports it.

- [ ] **Step 5: Verify the switch moves all three layers**

```bash
cd web && npm test && npm run typecheck && npm run build && npm run dev
```

At 390×844, press the theme button and confirm, for each direction of the switch:

- The basemap retints (roads and ground change, not just the cards).
- The risk cells retint, **including their hatching** — a pattern still showing the old theme's colour means `registerRiskPatterns` did not re-run.
- The map does not recentre or zoom.
- The legend rail swatches follow.
- Zero console errors.

Then, specifically: plan a safe route, switch theme, and confirm **the route is
still drawn**. Do the same with a search pin. Both were dropped by `setStyle`
and are restored by `reinstallOverlays`; if either vanishes, that restore is
wrong.

Then set the OS to dark, load with no stored preference, and confirm the app opens dark. Choose light manually, change the OS, and confirm the manual choice holds.

- [ ] **Step 6: Re-run the layout check in both themes**

Paste `docs/evidence/verify-layout.js` once per theme. Both must report `PASS`.

- [ ] **Step 7: Commit**

```bash
git add web/src/main.ts web/src/map.ts
git commit -m "Switch the interface, the basemap and the ramp together"
```

---

### Task 9: Documentation and deploy

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/build-log.md`

- [ ] **Step 1: Amend the two superseded decisions in `CLAUDE.md`**

In the **Locked decisions** table, change the Frontend row's rationale to note the two self-hosted subsets. Then replace the system-fonts justification in the UI section and the `min-height` paragraph with:

```markdown
- **Two self-hosted font subsets, 76 KB total.** This supersedes the original
  system-fonts-only rule. Source Serif 4 carries the reading sentence and
  Atkinson Hyperlegible Next carries everything else; Atkinson was drawn for
  low-acuity legibility, which is a functional argument on a screen read in rain
  and glare. Both are same-origin behind the existing cache, preloaded, and set
  `font-display: swap` behind a system fallback, so text paints immediately and
  the webfont never blocks. If a throttled-3G measurement shows first contentful
  paint regressing, revert to the fallback stacks — the type scale carries more
  of the hierarchy than the typeface does.
- **The map is the stage and all chrome floats above it.** Overlays are
  absolutely positioned and must never be added to normal flow. This replaces
  the old `min-height` floor and the arithmetic that maintained it: because
  overlays do not participate in layout, adding one can no longer push the page
  into scrolling. Verify with `docs/evidence/verify-layout.js` at 390×844.
- **Light and dark are a token pair, not two stylesheets.** Every colour,
  cartography included, is a custom property. The dark basemap is
  `color-scheme=Dark` appended to the style URL — already in the
  `TileCachePolicy` whitelist, so it needs no backend or template change.
```

- [ ] **Step 2: Record the session in `docs/build-log.md`**

Append an entry covering: what was attempted, the three production-relevant findings (Amazon Location's `color-scheme` verified against the live stack; `color-scheme` already whitelisted in `TileCachePolicy`, making this web-only; `setStyle` drops registered images so patterns must be re-registered rather than repainted), and what changed.

- [ ] **Step 3: Full local verification before any deploy**

```bash
cd web && npm test && npm run typecheck && npm run build
```

All three must pass.

- [ ] **Step 4: Deploy the web bundle only**

```bash
cd web && npm run deploy:web
```

No `sam deploy`. The stack is untouched, so there is no window in which it is half-migrated.

- [ ] **Step 5: Verify the ship gate**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://d227oixun34mjp.cloudfront.net/health
```

Expected: `200`.

Then load `https://d227oixun34mjp.cloudfront.net` on a 390×844 viewport, run `docs/evidence/verify-layout.js` in both themes, cycle all three views, and confirm zero console errors. Capture a screenshot of each theme into `docs/evidence/`.

If anything is wrong, roll back by re-syncing the previous `dist/` — do not debug against the live URL.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/build-log.md docs/evidence
git commit -m "Record the redesign and amend the decisions it supersedes"
```

---

## Deferred, deliberately

- **The `meaning` line per risk level** is hidden in the rail and belongs in the detail sheet. If it is not already shown there, that is a follow-up, not part of this plan.
- **A light/dark pair for directions A, B and C** is not built. They were comparison material.
- **Desktop beyond the single breakpoint** in Task 6 Step 3 is intentionally minimal.
