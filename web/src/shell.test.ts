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
