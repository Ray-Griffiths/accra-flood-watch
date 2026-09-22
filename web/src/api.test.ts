/**
 * How an API failure becomes a sentence.
 *
 * This file exists because of a silent regression rather than a hypothetical.
 * The handlers return `{ error }` and this client read `detail`, so every
 * rejection the backend had carefully worded -- "that location is outside the
 * area Accra Flood Watch covers" -- reached the user as "the service returned
 * 422". Nothing crashed and no test failed; the app simply stopped explaining
 * itself. The field name is asserted here so it cannot drift again.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ApiError, fetchRisk } from "./api.ts";

const BBOX: [number, number, number, number] = [-0.22, 5.56, -0.21, 5.57];

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answerWith(body: string, init: ResponseInit): void {
  globalThis.fetch = (() => Promise.resolve(new Response(body, init))) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): void {
  answerWith(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Captures the ApiError a call rejects with, failing if it resolves. */
async function rejection(call: () => Promise<unknown>): Promise<ApiError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("error messages", () => {
  it("reads the `error` field the handlers actually send", async () => {
    const message = "That location is outside the area Accra Flood Watch covers.";
    jsonResponse(422, { error: message });

    const error = await rejection(() => fetchRisk(BBOX));
    assert.equal(error.message, message);
    assert.equal(error.status, 422);
  });

  it("still reads a gateway-shaped `detail` body", async () => {
    jsonResponse(400, { detail: "bbox must be west,south,east,north in degrees" });

    const error = await rejection(() => fetchRisk(BBOX));
    assert.equal(error.message, "bbox must be west,south,east,north in degrees");
  });

  it("ignores an empty message rather than showing a blank explanation", async () => {
    jsonResponse(500, { error: "   " });

    const error = await rejection(() => fetchRisk(BBOX));
    assert.equal(error.message, "The service returned 500.");
  });

  it("falls back to the status when the body is not JSON at all", async () => {
    // What a gateway or an edge error page looks like.
    answerWith("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

    const error = await rejection(() => fetchRisk(BBOX));
    assert.equal(error.status, 502);
    assert.equal(error.message, "The service returned 502.");
  });

  it("reports an unreachable service distinctly from one that answered", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("network"))) as typeof fetch;

    const error = await rejection(() => fetchRisk(BBOX));
    assert.equal(error.status, 0);
    assert.match(error.message, /connection/i);
  });
});

describe("a successful response that is not JSON", () => {
  /**
   * CloudFront used to map 404 to index.html with a 200, distribution-wide,
   * so an unmatched API route answered with the app shell. Parsing that threw
   * a SyntaxError, which surfaced as an unexplained failure rather than as
   * anything a user or an operator could act on.
   */
  it("is refused as an unexpected reply, not parsed", async () => {
    answerWith("<!doctype html><title>Accra Flood Watch</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const error = await rejection(() => fetchRisk(BBOX));
    assert.match(error.message, /unexpected reply/i);
  });

  it("does not stand in the way of a normal response", async () => {
    jsonResponse(200, { cells: [], cellCount: 0 });

    const risk = await fetchRisk(BBOX);
    assert.deepEqual(risk.cells, []);
  });
});
