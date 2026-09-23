# Hybrid interface redesign

**Date:** 2026-09-23
**Status:** Approved, ready for planning
**Preview:** `.design-preview/directions.html` (direction D)

---

## 1. Goal

Replace the current stacked-band layout with a map-first layered one, in a new visual
language, and ship the app in both a light and a dark theme.

The app keeps every feature it has today. No handler, no endpoint, no data shape and no
risk logic changes. This is a change to `web/` and to two documentation files.

## 2. Why

Three problems, all of them structural rather than cosmetic.

**The map is losing to its own furniture.** At 390×844 the screen is seven stacked bands —
masthead 96, map 312, view bar 76, legend 96, disclaimer 80, dock 88. The map, which is the
product, gets 37%. `styles.css` carries a comment block recording the arithmetic needed to
stop the page scrolling each time a band was added, and a note that the view toggle already
pushed the layout 86px over once. That is a design that has to be re-measured rather than
one that holds.

**Three colour systems compete.** The navy brand, the status pill palette (green/amber/red)
and the risk ramp (blue→orange→red→dark red) plus purple terrain. A green "Updated just now"
pill reads as a risk level to someone scanning in a hurry. `Report water` is `--danger`
(`#6b0000`) — the exact colour the legend assigns to *Flooded now*.

**The app is built for a condition it does not render for.** `styles.css` opens by stating
the user is "outdoors, in rain, in bright light". It then ships a single light theme. Rain
in Accra is frequently after dark, and the app has no dark rendering at all.

## 3. Scope

**In**

- `web/index.html` — restructured markup
- `web/src/styles.css` — rewritten against a token system
- `web/src/levels.ts` — risk ramp becomes theme-aware
- `web/src/patterns.ts` — patterns redrawn on theme change
- `web/src/map.ts` — basemap colour scheme, pattern re-registration
- `web/src/main.ts` — theme wiring only; no change to existing flows
- new `web/src/theme.ts` and `web/src/theme.test.ts`
- `web/public/fonts/` — two self-hosted subsets
- `CLAUDE.md` — amend two locked decisions this supersedes
- `docs/build-log.md` — session entry

**Out**

- Any backend change. See §6 — the dark basemap needs none.
- Any change to `template.yaml`. See §6 — the cache policy already supports it.
- Any change to risk scoring, routing, reporting, watches, search, i18n or offline queue.
- Light/dark for directions A, B and C. They were comparison material and are discarded.

## 4. The structural change

Stop stacking. Start layering.

The map becomes the stage and fills it. Everything else floats above it with an explicit
z-order and safe-area gutters. Because overlays are absolutely positioned they do not
participate in flow, so no overlay can push the page into scrolling. The `min-height: 35vh`
floor and the arithmetic that maintains it are deleted, not re-tuned.

```
┌──────────────────────────────┐
│  Alajo Crescent is passable.  │  serif reading card, full width, top 14
│  Two streets flooded within…  │
│  ● Updated 2 min ago          │
│                        ┌───┐  │  search          ─┐ control column,
│                        └───┘  │                   │ top right, 46px
│                        ┌───┐  │  theme switch    ─┘ targets
│                        └───┘  │
│           M A P        ┌────┐ │
│                        │▉ Fl│ │  gauge rail, vertically
│                        │▉ Hi│ │  centred on the right edge
│                        │▉ Wa│ │
│                        │▉ Lo│ │
│                        └────┘ │
│                               │
│ [Now][Later][Rain]   ┌──────┐ │  segments left, actions right
│                      │Report│ │
├───────────────────────────────┤
│ Community tool, not an official│  always visible, 12px, 2 lines
└───────────────────────────────┘
```

Measured in the preview at 390×844, across 4 directions × 3 views × 2 themes: zero overlaps,
zero page scroll. The verification is a geometry assertion, not a screenshot — see §9.

**Map padding.** Because chrome now occludes the edges, `map.easeTo`/`fitBounds` must be
given a `padding` object matching the occluded insets, or a flown-to pin lands under the
reading card. This is the one behavioural regression risk in the layout change and is called
out as its own task.

## 5. Visual system

### Colour

Tokens, not literals, everywhere — including the cartography. This is what makes the theme
swap one stylesheet rather than two that drift apart.

| Token | Dark | Light |
|---|---|---|
| `--ground` | `#0A1218` | `#E6ECEF` |
| `--surface` | `#16222B` | `#FFFFFF` |
| `--ink` | `#E8F1F5` | `#0E2029` |
| `--ink-2` | `#9DB8C6` | `#4C6672` |
| `--live` | `#5FE3A1` | `#1A7F4F` |

Risk ramp (`--k-*`), which is the only saturated colour in the interface:

| Level | Dark | Light |
|---|---|---|
| Low | `#5B8CA6` | `#8FB0C4` |
| Watch | `#FFC53D` | `#E0A511` |
| High | `#FF7A1F` | `#E35D18` |
| Flooded now | `#FF4530` | `#C8261A` |

Terrain band (`floods-first` / `floods-heavy` / `usually-dry`) keeps its purple language,
deliberately distinct from the live ramp, per the existing rule in `CLAUDE.md`.

The light side is **not an inversion**. The ramp keeps its meaning but drops to hues that
survive on paper, and the ground stays cool rather than white so a low-risk cell still reads
as *an overlay that loaded* rather than as blank map. That distinction is a safety property:
"no data" and "low risk" must never look the same.

Two rules follow from §2 and are non-negotiable:

- **Saturated colour is reserved for risk.** Freshness and status use neutrals plus `--live`.
- **`Report water` is never a ramp colour.** It takes `--ink` on dark, `--ground`-dark on
  light. Today it is `#6b0000`, which is *Flooded now*.

### Type

Source Serif 4 for the reading sentence only; Atkinson Hyperlegible Next for everything else.

| Role | Face | Size / weight |
|---|---|---|
| Reading sentence | Source Serif 4 | 20 / 700, `line-height` 1.3 |
| Score | Source Serif 4 | 30 / 700, tabular |
| Body, UI, labels | Atkinson | 15 / 400 |
| Legend, rail, legal | Atkinson | 12 / 400–700 |

Serif runs at 700 rather than book weight: on a dark ground the strokes thin out and drift
toward looking like a luxury brand rather than a warning.

Atkinson Hyperlegible Next was drawn by the Braille Institute to keep characters apart at
low acuity. For a screen read in rain and glare that is a functional argument, not a
stylistic one.

**Minimum type size is 12px anywhere on the phone.** The first pass of the preview used
10.5px legend text and 8.5px rail labels; those undercut the entire premise and were raised.

## 6. Theme architecture

The only genuinely new machinery. Three layers must move together or the result is a dark
interface over a light map.

### 6.1 Basemap — no backend change needed

`getConfig` returns `styleUrl: /v2/styles/Standard/descriptor?key=…`. Amazon Location's
style descriptor accepts a `color-scheme` parameter, and **the client can append it**.

Verified against the live stack on 2026-09-23:

| Request | Result |
|---|---|
| no parameter | 138,746 bytes, 160 layers |
| `&color-scheme=Light` | **byte-identical to no parameter** — Light is the default |
| `&color-scheme=Dark` | 138,318 bytes, 160 layers — a genuinely different descriptor |

And `color-scheme` is **already** in the `TileCachePolicy` query-string whitelist in
`template.yaml`, so the two variants get separate cache keys rather than colliding.

Consequence: **this ships as a web-only deploy.** No `sam deploy`, no template change, no
Lambda change. That materially reduces ship-gate risk — the riskiest thing we do is an S3
sync and an invalidation, which is what `npm run deploy:web` already does.

### 6.2 Switching the basemap at runtime

`map.setStyle(url)` drops all sources *and* all registered images. `map.ts` already
anticipates this: `installOverlays` is documented as "called once the style is ready, and
again if the style ever reloads (which drops both sources and images)". The theme switch
reuses that path.

Sequence, which must be exact:

1. Capture camera (`center`, `zoom`, `bearing`, `pitch`).
2. `map.setStyle(styleUrlFor(theme))`.
3. On `styledata`, `installOverlays(map)` — re-adds sources, re-registers patterns.
4. Re-apply the current view's paint and re-push the current GeoJSON.
5. Restore camera.

Camera restore is needed because `setStyle` preserves the camera only when the new style is
judged compatible; relying on that is how a theme switch silently recentres the map.

### 6.3 Risk ramp and patterns

`LEVEL_STYLES` in `levels.ts` currently carries a single `colour: string`. It becomes
`colour: { light: string; dark: string }`, with a `colourFor(style, theme)` accessor.

Three consumers must follow:

- `patterns.ts` — `draw(kind, colour)` renders to canvas from `style.colour`. Patterns are
  registered images and must be **redrawn and re-registered** on theme change, not just
  repainted. `installOverlays` already calls `registerRiskPatterns`, so step 6.2.3 covers it.
- `map.ts` — `matchByView(…, (s) => s.colour, …)` becomes theme-aware. The hard-coded
  `"#2b83ba"` fallbacks become theme-aware too.
- `main.ts` `renderLegend` — sets `--level-colour` from `style.colour`; takes the token
  instead so the legend follows a CSS-only theme change without a re-render.

### 6.4 Resolution and persistence

New `web/src/theme.ts`, pure and unit-tested, owning the rules:

- Default follows `prefers-color-scheme`, and **keeps following it** while no manual
  choice exists.
- A manual choice is sticky and persisted in `localStorage` under one key.
- Resolution order: manual choice → system preference → dark.

`localStorage` is already used for the offline queue and saved commutes. A theme preference
is not a device identifier and does not touch the privacy rules in `CLAUDE.md`.

The control is a 46px button in the top-right column. Its icon shows the **current** state
(moon in dark, sun in light) and its `aria-label` describes the **action** ("Switch to light
theme"). Both must update together.

## 7. DOM contract

`main.ts` and the sheet modules query a bounded set of selectors. Restructuring the markup
must preserve every one of these, or the app breaks silently at runtime — TypeScript cannot
catch it, because they are all `querySelector(...)!` with a non-null assertion.

Preserve exactly: `#status`, `#tagline`, `#map`, `#legend`, `#search`, `.search__input`,
`.search__clear`, `.search__results`, `.language`, `#language-select`, `.language__notice`,
`.view-bar`, `#view-reason`, `.view-toggle__option[data-view]`, `#route-button`,
`#route-prompt`, `.route-prompt__text`, `#route-cancel`, `#report-button`,
`#report-button .report-button__label`, `#detail-sheet`, `#route-sheet`, `#report-sheet`,
`.sheet__body`, `.sheet__close`, `.disclaimer strong`.

Classes written by `main.ts` that the new CSS must still style: `status status--{state}`,
`map--picking`, `legend__list`, `legend__item`, `legend__swatch legend__swatch--{value}`,
`legend__text`, `view-bar--overridden`, `watch`, `watch__status`, `watch__status--on`,
`watch__status--error`, `button button--secondary`, `language__notice`.

**Two elements change role rather than disappear:**

- `#status` stops being a pill in the masthead and becomes the freshness line inside the
  reading card. Same node, same `status--{state}` classes, new position and styling.
- `#legend` stops being a full-width band and becomes the gauge rail. `renderLegend` builds
  a `ul.legend__list` and calls `replaceChildren`, which wipes anything else inside the
  node. So the rail is a **wrapper**: `<div class="rail"><div id="legend"></div><p
  class="rail__cap">worst in view</p></div>`. The cap is a sibling of `#legend`, not a
  child, and therefore survives every re-render. `renderLegend` needs no change at all.

The masthead `<h1>` is removed from the phone layout; the app name lives in the PWA chrome
and the desktop rail. `#tagline` is written by `main.ts` from live coverage data and states
which areas the grid actually covers, so it must stay visible rather than move into a sheet:
**it renders in the reading card's secondary row, after `#status`**, at `--ink-2`. It is
allowed to wrap to a second line there, and that wrapped state is the worst case the card
height must be measured against — see §9, where the control column's offset is derived from
the tallest card, not the current one.

## 8. Amendments to CLAUDE.md

Two locked decisions are superseded. The plan must update `CLAUDE.md` in the same commit,
or the file starts lying about the code.

**System fonts.** The current rule: "system fonts, because a webfont is a render-blocking
round trip on a connection that is already struggling." Superseded with conditions — two
subsets totalling **76 KB**, self-hosted same-origin behind the existing CloudFront cache,
`font-display: swap` with a metric-adjusted system fallback, and `<link rel=preload>`. Text
renders immediately in the fallback and never blocks. The risk overlay still loads before
tiles. If a measurement shows first contentful paint regressing on a throttled 3G profile,
this reverts to system fonts and the design holds — the type scale carries more of the
hierarchy than the typeface does.

**The map min-height floor.** The rule describing `min-height: 35vh` and the requirement to
re-check it when adding a band is deleted. The mechanism it protects no longer exists. It is
replaced with: overlays are absolutely positioned and must never be added to normal flow.

## 9. Testing

Logic tests stay green untouched — `view.test.ts`, `viewport.test.ts`, `pilot.test.ts`,
`queue.test.ts`, `search.test.ts`, `i18n.test.ts`, `url-state.test.ts`, `commute.test.ts`,
`api.test.ts`. If any of them changes, something out of scope has moved.

New:

- `theme.test.ts` — resolution order, stickiness, system-preference following while no
  manual choice exists, and a malformed `localStorage` value falling back rather than
  throwing.
- `levels.test.ts` — every level and terrain band defines **both** themes; no `undefined`
  reachable from `colourFor`; the live ramp and the terrain ramp share no colour.
- Contrast assertion over the token table: every ink/surface pair ≥ 4.5:1 in both themes.
  The preview shipped six genuine contrast failures that only surfaced when measured.

Browser verification, scripted rather than eyeballed — this caught every real bug in the
preview and three of them were invisible in screenshots:

- At 390×844, `document.body.scrollHeight <= window.innerHeight` in both themes.
- No two overlays overlap, across every view × theme combination.
- The disclaimer is fully within the viewport in both themes.
- Zero console errors after cycling every view and both themes.

## 10. Rollout

The ship gate governs. The public URL must not break.

1. Build and verify locally at 390×844 and 1440.
2. `npm run build`, then `npm run deploy:web` — S3 sync plus CloudFront invalidation.
3. `curl https://d227oixun34mjp.cloudfront.net/health` and confirm 200.
4. Load the live URL on a phone viewport, cycle both themes and all three views.

No `sam deploy` is involved, so there is no window in which the stack is half-migrated.
Rollback is re-syncing the previous `dist/`.

`service-worker.js` caches the shell. `index.html` and the service worker are uploaded
`no-cache`, so the new shell reaches users on next load. The new font files are hashed
assets under the immutable policy. The service worker must continue to exclude `/v2/*`, or
it will cache tiles without bound — and it now has two colour variants to cache, which
doubles the exposure if that exclusion is ever dropped.

## 11. Risks

| Risk | Mitigation |
|---|---|
| A preserved selector is missed and a flow breaks silently at runtime | §7 is the checklist; add a smoke test that asserts every listed selector resolves after load |
| `setStyle` recentres the map or drops the overlay | Explicit camera capture/restore and re-install, §6.2; verified live before deploy |
| Patterns keep stale colours after a theme switch | Patterns are re-registered, not repainted, §6.3; asserted in browser verification |
| Webfont regresses paint on a poor connection | Preload + `swap` + same-origin; measured on a throttled profile, revert path stated in §8 |
| Serif on dark reads as a luxury brand rather than a warning | Weight 700, one job only, reviewed against the preview |
| Dark map is worse in direct midday sun | The light theme is exactly this mitigation, and the default follows the system |
| Scope creep into backend | §6.1 — the feature needs no backend change; any change there is out of scope |
