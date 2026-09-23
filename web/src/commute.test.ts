/**
 * The saved journey.
 *
 * A commute is the most identifying thing this application could hold — a
 * home, a workplace and a time of day — so it never leaves the device. What
 * is worth testing is the reading: localStorage is writable by anything else
 * on this origin, and a malformed entry must read as "none saved" rather than
 * reaching a routing request as NaN coordinates.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { forgetCommute, loadCommute, saveCommute } from "./commute.ts";

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

const KEY = "afw:commute";

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe("round trip", () => {
  it("returns what was saved", () => {
    saveCommute({
      origin: [-0.2231, 5.5483],
      destination: [-0.2074, 5.5712],
      mode: "walking",
      label: "to work",
    });

    const saved = loadCommute();
    assert.deepEqual(saved?.origin, [-0.2231, 5.5483]);
    assert.deepEqual(saved?.destination, [-0.2074, 5.5712]);
    assert.equal(saved?.mode, "walking");
    assert.equal(saved?.label, "to work");
  });

  it("forgets completely", () => {
    saveCommute({
      origin: [-0.22, 5.55],
      destination: [-0.21, 5.57],
      mode: "driving",
      label: "to home",
    });
    forgetCommute();
    assert.equal(loadCommute(), null);
  });

  it("reports nothing saved on a clean device", () => {
    assert.equal(loadCommute(), null);
  });
});

describe("refusing a corrupted entry", () => {
  function store(value: unknown): void {
    localStorage.setItem(KEY, typeof value === "string" ? value : JSON.stringify(value));
  }

  it("refuses coordinates that are not numbers", () => {
    // The one that matters: NaN reaching the routing request would become a
    // nonsense trip rather than an obvious failure.
    store({ origin: ["a", "b"], destination: [-0.21, 5.57], mode: "walking" });
    assert.equal(loadCommute(), null);
  });

  it("refuses an incomplete pair", () => {
    store({ origin: [-0.22], destination: [-0.21, 5.57], mode: "walking" });
    assert.equal(loadCommute(), null);
  });

  it("refuses a missing destination", () => {
    store({ origin: [-0.22, 5.55], mode: "walking" });
    assert.equal(loadCommute(), null);
  });

  it("refuses an unknown travel mode", () => {
    store({ origin: [-0.22, 5.55], destination: [-0.21, 5.57], mode: "teleport" });
    assert.equal(loadCommute(), null);
  });

  it("refuses unparseable JSON", () => {
    store("{not json");
    assert.equal(loadCommute(), null);
  });

  it("supplies a label when one is missing rather than failing", () => {
    // A missing label is cosmetic; the journey is still usable.
    store({ origin: [-0.22, 5.55], destination: [-0.21, 5.57], mode: "driving" });
    const saved = loadCommute();
    assert.ok(saved, "a usable journey must survive a missing label");
    assert.ok(saved.label.length > 0);
  });
});
