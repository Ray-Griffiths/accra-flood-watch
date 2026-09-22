/**
 * The offline report queue.
 *
 * The queue's whole reason to exist is that a report made with no signal must
 * not be lost. Its whole risk is the opposite failure: a held report arriving
 * later and being written as though the water were there now. Both directions
 * are asserted here.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MAX_QUEUE_AGE_MINUTES, clear, enqueue, flush, pendingCount } from "./queue.ts";
import type { PendingReport } from "./queue.ts";

// A minimal localStorage, since node has none.
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

const realFetch = globalThis.fetch;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function report(overrides: Partial<PendingReport> = {}): PendingReport {
  return {
    latitude: 5.5712,
    longitude: -0.2074,
    depth: "knee",
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Records every request body the flush sends. */
function captureSends(status = 201): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify({ accepted: true }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return seen;
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("holding a report", () => {
  it("keeps it and counts it", () => {
    assert.equal(enqueue(report()), true);
    assert.equal(pendingCount(), 1);
  });

  it("refuses rather than growing without bound", () => {
    for (let i = 0; i < 20; i += 1) assert.equal(enqueue(report()), true);
    // The caller needs a false here so it can tell the user it was not kept.
    assert.equal(enqueue(report()), false);
  });

  it("stops counting an entry once it is too old to be true", () => {
    enqueue(report({ observedAt: minutesAgo(MAX_QUEUE_AGE_MINUTES + 1) }));
    assert.equal(pendingCount(), 0);
  });
});

describe("flushing", () => {
  it("sends the observation time, not the moment it reconnected", async () => {
    const observedAt = minutesAgo(10);
    enqueue(report({ observedAt }));

    const sent = captureSends();
    const result = await flush();

    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    // The load-bearing assertion: without this the server stamps it as now,
    // and ten-minute-old water is presented as current.
    assert.equal(sent[0]!["observedAt"], observedAt);
  });

  it("discards a stale entry instead of sending it", async () => {
    enqueue(report({ observedAt: minutesAgo(MAX_QUEUE_AGE_MINUTES + 5) }));

    const sent = captureSends();
    const result = await flush();

    assert.equal(sent.length, 0, "a stale report must never reach the service");
    assert.equal(result.expired, 1);
    assert.equal(result.sent, 0);
    assert.equal(pendingCount(), 0);
  });

  it("sends oldest first, so the most perishable goes before the rest", async () => {
    enqueue(report({ observedAt: minutesAgo(2), depth: "ankle" }));
    enqueue(report({ observedAt: minutesAgo(20), depth: "waist" }));

    const sent = captureSends();
    await flush();

    assert.deepEqual(
      sent.map((body) => body["depth"]),
      ["waist", "ankle"],
    );
  });

  it("keeps everything queued when the service cannot be reached", async () => {
    enqueue(report());
    enqueue(report());

    globalThis.fetch = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
    const result = await flush();

    assert.equal(result.sent, 0);
    assert.equal(result.remaining, 2);
    assert.equal(pendingCount(), 2);
  });

  it("drops a report the server refuses rather than retrying it forever", async () => {
    enqueue(report());

    captureSends(422);
    const result = await flush();

    assert.equal(result.sent, 0);
    assert.equal(pendingCount(), 0, "an answered refusal is final");
  });

  it("stops at the first network failure instead of hammering a dead link", async () => {
    enqueue(report({ observedAt: minutesAgo(20) }));
    enqueue(report({ observedAt: minutesAgo(10) }));
    enqueue(report({ observedAt: minutesAgo(5) }));

    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response("{}", { status: 201, headers: { "content-type": "application/json" } }),
        );
      }
      return Promise.reject(new TypeError("offline"));
    }) as typeof fetch;

    const result = await flush();

    assert.equal(result.sent, 1);
    assert.equal(calls, 2, "one success, one failure, then stop");
    assert.equal(result.remaining, 2);
  });
});
