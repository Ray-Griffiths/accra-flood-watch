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
