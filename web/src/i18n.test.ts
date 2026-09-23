/**
 * The translation table.
 *
 * Two properties matter more than the words themselves, because both are the
 * kind of thing that breaks silently: every locale must resolve every key a
 * screen needs, and a gap must land on English rather than on a raw key.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DRAFT_LOCALES,
  LOCALES,
  LOCALE_NAMES,
  getLocale,
  isDraftLocale,
  isLocale,
  setLocale,
  t,
} from "./i18n.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  (globalThis as { document?: unknown }).document = { documentElement: { lang: "en" } };
});

afterEach(() => setLocale("en"));

/** Strings without which a screen cannot be navigated at all. */
const ESSENTIAL_KEYS = [
  "level.low",
  "level.watch",
  "level.high",
  "level.confirmed",
  "view.now",
  "view.later",
  "view.terrain",
  "action.report",
  "action.route",
  "depth.ankle",
  "depth.knee",
  "depth.waist",
  "depth.impassable",
  "depth.cleared",
  "disclaimer.lead",
];

describe("coverage", () => {
  it("resolves every essential key in every locale", () => {
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const key of ESSENTIAL_KEYS) {
        const value = t(key);
        // A raw key on screen is readable by nobody. English at least is
        // readable by someone.
        assert.notEqual(value, key, `${locale} left ${key} unresolved`);
        assert.ok(value.length > 0, `${locale} has an empty ${key}`);
      }
    }
  });

  it("gives every locale a name in its own right", () => {
    for (const locale of LOCALES) {
      assert.ok(LOCALE_NAMES[locale]?.length > 0);
    }
  });

  it("translates the four risk levels away from English", () => {
    // Guards against a catalog that looks populated but is a copy of English.
    for (const locale of DRAFT_LOCALES) {
      setLocale("en");
      const english = ESSENTIAL_KEYS.map((key) => t(key));
      setLocale(locale);
      const translated = ESSENTIAL_KEYS.map((key) => t(key));
      const identical = english.filter((value, i) => value === translated[i]);
      assert.ok(
        identical.length < english.length / 2,
        `${locale} looks like untranslated English`,
      );
    }
  });
});

describe("falling back", () => {
  it("uses English for a key a locale has not translated", () => {
    // `app.tagline.fallback` is deliberately English-only: the draft catalogs
    // cover the navigational vocabulary and leave the rest to fall through.
    // If this key ever gets translated, point this test at another untranslated
    // one rather than deleting it — the fallback is what keeps a partial
    // catalog usable instead of showing raw keys.
    setLocale("en");
    const english = t("app.tagline.fallback");

    for (const locale of ["tw", "ga"] as const) {
      setLocale(locale);
      assert.equal(t("app.tagline.fallback"), english, `${locale} should fall back`);
      assert.notEqual(t("app.tagline.fallback"), "app.tagline.fallback");
    }
  });

  it("returns the key itself only when English is missing it too", () => {
    assert.equal(t("no.such.key.anywhere"), "no.such.key.anywhere");
  });
});

describe("choosing a locale", () => {
  it("remembers the choice", () => {
    setLocale("ga");
    assert.equal(getLocale(), "ga");
    assert.equal(localStorage.getItem("afw:locale"), "ga");
  });

  it("rejects anything that is not a known locale", () => {
    assert.equal(isLocale("fr"), false);
    assert.equal(isLocale(""), false);
    assert.equal(isLocale(null), false);
    assert.equal(isLocale("tw"), true);
  });

  it("flags the drafts and not English", () => {
    // The user is entitled to know they are reading an unreviewed warning.
    assert.equal(isDraftLocale("en"), false);
    assert.equal(isDraftLocale("tw"), true);
    assert.equal(isDraftLocale("ga"), true);
  });
});
