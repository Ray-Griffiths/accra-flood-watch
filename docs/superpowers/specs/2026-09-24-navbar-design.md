# Navbar Design

**Date:** 2026-09-24
**Status:** Approved
**Supersedes:** the floating `.ov-tools` control column introduced in the hybrid interface redesign (Tasks 4–8).

## Problem

After the hybrid interface redesign the app has no name anywhere on screen — the
masthead was removed in Task 4 and "Accra Flood Watch" survives only in
`<title>`. For a project judged partly on communication quality, the app never
introduces itself.

Separately, search, the theme toggle and the language select float as a loose
column down the right-hand side (`.ov-tools`, occupying y 156–308 at 390×844).
Three unrelated controls stacked over the map read as leftovers rather than as
chrome.

## Goal

One full-width navbar pinned to the top edge carrying the app name, search,
theme and language. Below 600px the theme and language controls collapse behind
a hamburger; search stays on the bar.

## Non-goals

- No new settings. The navbar carries exactly what `.ov-tools` carried, plus the name.
- No navigation. There is one screen; this is a title bar, not a router.
- No change to the reading card's content, the rail, the segments, the dock or
  the disclaimer.

## Design

### One set of controls

The controls are rendered **once**. `#navbar-controls` is an inline flex row on
the bar at ≥600px; below that the *same element* becomes an absolutely
positioned dropdown panel. Only CSS changes between the two.

This is the central constraint. Rendering the controls twice — once for the bar,
once for the menu — would duplicate `#theme-toggle` and `#language-select`,
which the application reaches by unique id (`elements.themeToggle`,
`elements.languageSelect`), and would give one setting two sources of truth.

```html
<header class="ov ov-nav navbar">
  <h1 class="navbar__name">Accra Flood Watch</h1>

  <form id="search" class="search" role="search" autocomplete="off">…</form>

  <div class="navbar__controls" id="navbar-controls">
    <button id="theme-toggle" class="tool">
      <svg class="tool__moon">…</svg>
      <svg class="tool__sun">…</svg>
      <span class="tool__label"></span>
    </button>
    <div class="language">
      <label class="search__label" for="language-select">Language</label>
      <select id="language-select" class="language__select"></select>
    </div>
  </div>

  <button id="nav-menu" class="tool navbar__burger" type="button"
          aria-expanded="false" aria-controls="navbar-controls"
          aria-label="Settings">…</button>
</header>
```

`.ov-tools` is deleted from both markup and stylesheet. The right-hand band it
occupied returns to the map.

### Breakpoint: 600px

Chosen from content, not convention. Inline, the bar needs roughly:

| item | width |
|---|---|
| name at 15px/700 | ~140px |
| search, collapsed | 44px |
| theme toggle | 44px |
| language select | ~86px |
| three gaps + padding | ~44px |
| **total** | **~358px** |

That fits at 600px with room to spare and does not fit at 390px. Collapsed to a
hamburger the bar needs ~264px, which fits a 320px screen.

A 700px tablet in portrait therefore gets the full inline bar. That is
deliberate: there is room for it, and a hamburger that hides two controls on a
screen wide enough to show them is hiding them for nothing.

### The menu

Below 600px, `#navbar-controls` becomes a 220px panel anchored under the
hamburger, right-aligned, `display: none` until `.navbar--menu-open` is set.

`display: none` is doing real work: it takes the panel's contents out of the tab
order for free, so focus cannot land on a control that is not on screen. No
`inert`, no focus trap.

The theme button gains a `.tool__label` span, hidden on the bar and shown in the
panel. Its text is the **same string** already computed for the button's
`aria-label` ("Switch to light theme" / "Switch to dark theme"), assigned in the
same place, so there is one string rather than two that can drift.

Behaviour:

- Click the hamburger → toggle `.navbar--menu-open` and `aria-expanded`.
- `Escape` → close, return focus to the hamburger.
- Click outside `.navbar` → close.
- Choosing a theme or a language → close.

### Search on the bar

Collapsed, search is a 44px icon as it is today. On focus, `.search` takes
`flex: 1` and the name, controls and hamburger hide, so the field fills the bar.
No `100vw` arithmetic is needed, because the bar is already the full width.

Both fixes from the overlay-geometry task carry over unchanged:

- The field stays expanded while the results are open, not merely while the
  input has focus — otherwise tapping a result collapses the field as the finger
  is coming down.
- Elements the results panel covers are hidden rather than merely overlaid, so
  focus cannot reach them.

The results panel anchors to `.navbar` rather than to `.search`
(`top: calc(100% + 8px); left: 12px; right: 12px`), so it is full width whether
the field is expanded or not.

### Geometry

Two new theme-neutral tokens:

- `--nav-h: 56px` — the 46px square the search field and theme button already
  are, plus 5px padding either side.
- `--safe-top: env(safe-area-inset-top, 0px)` — needed now that something is
  pinned to the top edge, which nothing was before.

At 390×844:

| element | before | after |
|---|---|---|
| `.navbar` | — | `0 → 56`, full width |
| `.ov-read` | `14 → 139` | `64 → ~215` |
| `.ov-tools` | `156 → 308` | **removed** |
| `.rail` | `322 → 522` | unchanged |
| `.ov-seg` | `611 → 647` | unchanged |
| `.ov-dock` | `659 → 760` | unchanged |
| `.ov-legal` | `779 → 844` | unchanged |

`MAP_PADDING.top` moves 150 → 260, taken from the reading card's TALLEST state:
in English it ends at y~215, but in Twi or Gã the draft-translation notice runs
to three lines and pushes it to y~249. Sizing to the common case would hide a
searched pin for exactly the users already reading the app in a second
language.

On desktop (≥900px) the bar spans both columns. `.map` insets to
`var(--nav-h) 0 0 344px`, and the sidebar's first card takes
`margin-top: calc(var(--nav-h) + 18px)`.

The margin is deliberate and **stage padding would be wrong**: absolutely
positioned children resolve against their containing block's *padding* box, so
padding the stage would push the navbar down along with everything else.

### The draft-translation notice

Twi and Gã are unreviewed translations. Today a notice sits permanently beside
the language select saying so. Moving the select into a menu would make that
notice visible only while the menu is open — a regression on a safety
disclosure.

`paintDraftNotice` therefore stops appending into `.language` and instead fills
a fixed `<span id="draft-notice">` in the reading-card meta row, using the same
`t("language.draft")` string it uses now. It sits beside the status dot and the
catchment name, next to the sentence it qualifies, and is visible regardless of
where the language control lives — strictly better than the current behaviour.

## Testing

`shell.test.ts` gains:

- the navbar ids and classes in the existing `IDS` / `CLASSES` contracts;
- `#theme-toggle` and `#language-select` must be **inside** `#navbar-controls`;
- each of `#theme-toggle` and `#language-select` must appear **exactly once** in
  the document. This is the assertion that stops the duplicate-controls design
  creeping back, and it is the one most worth having.

`contrast.test.ts` adds `--nav-h` and `--safe-top` to `THEME_NEUTRAL`, so the
"every colour token is defined in both themes" check keeps covering only colour.

`docs/evidence/verify-layout.js` adds `.navbar` to its overlay set and drops
`.ov-tools`.

Browser verification, in both themes: 390×844, 1440×900, and 599/600px either
side of the breakpoint; menu open and closed; search collapsed and expanded.
Expected `PASS` throughout with zero console errors.

## Risks

- **The bar competes with the reading card for the top band.** Mitigated by
  deleting `.ov-tools`: the top grows ~76px, the right-hand column gives back
  152px, and the map nets out ahead.
- **The notch.** `--safe-top` is introduced with the navbar rather than
  discovered on a device later.
- **`:has()` usage grows.** The navbar adds two more `:has()` rules to the two
  the stylesheet already carries. Baseline is Chrome 105+ / Safari 15.4+, which
  the low-end-Android target clears.

## Implementation notes

Three things that only showed up in a real browser:

- **`.tool { display: grid }` beat `.navbar__burger { display: none }`.** Equal
  specificity, and `.tool` is declared further down the file, so the hamburger
  showed at every width. The base and media-query rules are both written
  `.tool.navbar__burger` to out-specify it.
- **The desktop sidebar margin inset the bar.** `.stage > .ov` carries
  `margin-inline: 22px` for the sidebar cards, and the navbar is one of those
  children — it rendered 22px short at each end. Excluded with `:not(.ov-nav)`.
- **The draft notice is a full sentence, not a chip.** The design sketch showed
  a short "Twi draft" marker; the shipped notice is the whole
  `t("language.draft")` string, because the actionable half of it is "warnings
  are most reliable in English". It takes the reading card to 249px in a draft
  locale, which was measured against the rail at 329px and leaves 80px clear.

---

## Amendment, same day: bottom cluster, and two search bugs

### Search was unusable by touch

Collapsed, `.search__field` is 46px and `.search__icon` occupies all 46px of
it; the input beside it is squeezed to **4px** and clipped by
`overflow: hidden`. A tap therefore landed on a `<span>`, which cannot take
focus, so the field never expanded. Measured with `elementFromPoint` at the
centre of the field: the hit target was `SPAN.search__icon`.

This had been true since the overlay-geometry task. Every check until now
focused the input programmatically, which is precisely the one way a user
cannot. The icon is now a `<label for="search-input">` — a label focuses its
control, no JS — and `shell.test.ts` fails if it reverts to a span.

### Search stretched across the desktop

`.navbar:has(.search:focus-within) .search { flex: 1 }` and the rules hiding
the name and controls were unscoped, so on a 1440px window focusing the field
stretched it across the whole bar. They now live in `@media (max-width: 899px)`.
Above that the bar has room for everything at once, so nothing has to give way:
the field is a fixed 260px, and the results panel is 420px anchored under it
rather than spanning the window.

### The bottom cluster

On phones the dock is a **row** of two equal halves (179px each at 390px), with
the three view toggles directly above it spanning the same 366px in equal
thirds. One left edge and one right edge for the whole cluster instead of four.
`.ov-seg`'s offset is `calc(var(--legal-reserve) + 58px)` — the dock's height
plus a gap.

On desktop the sidebar became a **flex column** rather than a grid. The grid
packed its rows at the top and left ~270px of dead space beneath, so
`margin-top: auto` on `.ov-seg` now takes the slack and pushes the toggles, the
dock and the disclaimer to the foot of the column — the same order they appear
in at the bottom of a phone. The dock stacks there rather than sitting side by
side: two buttons in a 300px column are 146px each, which "Report water" does
not clear at 14px bold with its icon. Both are full width, so they are the same
size as each other, which was the point.

Measured at 1440×900: reading card 74–225, rail 239–368, toggles 635–671, dock
685–787, disclaimer 801–882 with an 18px foot.
