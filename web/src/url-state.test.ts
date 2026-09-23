/**
 * Link intents.
 *
 * A shared link is the one input to this app that arrives from outside it,
 * via a messaging app that may well have mangled it. Parsing is therefore
 * total: every malformed case must yield "no intent" and open the plain map,
 * never an error and never a wrong place.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readIntent, shareUrlFor } from "./url-state.ts";

describe("reading a shared place", () => {
  it("accepts a well-formed pair", () => {
    assert.deepEqual(readIntent("?at=-0.2074,5.5712").at, [-0.2074, 5.5712]);
  });

  it("tolerates whitespace a chat app may have introduced", () => {
    assert.deepEqual(readIntent("?at=-0.2074, 5.5712").at, [-0.2074, 5.5712]);
  });

  it("ignores anything that is not two finite numbers", () => {
    for (const bad of ["", "?at=", "?at=5.57", "?at=a,b", "?at=1,2,3", "?at=NaN,5.5"]) {
      assert.equal(readIntent(bad).at, undefined, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("refuses coordinates that are not on Earth", () => {
    assert.equal(readIntent("?at=200,5.5").at, undefined);
    assert.equal(readIntent("?at=-0.2,95").at, undefined);
  });

  it("does not confuse longitude and latitude order", () => {
    // Accra is roughly lon -0.2, lat 5.6. Swapping them would put the pin in
    // the Gulf of Guinea, so the order is worth pinning down.
    const intent = readIntent("?at=-0.2074,5.5712");
    assert.equal(intent.at?.[0], -0.2074, "first value is longitude");
    assert.equal(intent.at?.[1], 5.5712, "second value is latitude");
  });
});

describe("reading a shortcut action", () => {
  it("accepts the two the manifest declares", () => {
    assert.equal(readIntent("?action=report").action, "report");
    assert.equal(readIntent("?action=route").action, "route");
  });

  it("ignores anything else", () => {
    for (const bad of ["?action=delete", "?action=", "?action=REPORT"]) {
      assert.equal(readIntent(bad).action, undefined, `accepted ${bad}`);
    }
  });

  it("reads a place and an action together", () => {
    const intent = readIntent("?at=-0.2074,5.5712&action=route");
    assert.deepEqual(intent.at, [-0.2074, 5.5712]);
    assert.equal(intent.action, "route");
  });
});

describe("building a link to share", () => {
  it("round-trips through the parser", () => {
    const url = shareUrlFor([-0.2074, 5.5712], "https://example.test/");
    const intent = readIntent(new URL(url).search);

    assert.ok(intent.at);
    // Five decimals is ~1.1m, far inside a 152m cell.
    assert.ok(Math.abs(intent.at[0] - -0.2074) < 1e-5);
    assert.ok(Math.abs(intent.at[1] - 5.5712) < 1e-5);
  });

  it("does not accumulate parameters when sharing from a shared link", () => {
    const url = shareUrlFor([-0.21, 5.6], "https://example.test/?at=-0.3,5.4&action=route");
    const params = new URL(url).searchParams;

    assert.deepEqual([...params.keys()], ["at"]);
    assert.equal(params.get("at"), "-0.21000,5.60000");
  });
});
