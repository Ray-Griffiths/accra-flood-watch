/**
 * When an alert fires, and what it says.
 *
 * The firing rule is the one that decides whether people keep notifications
 * switched on. Alerting every hour while a cell stays dangerous is how they
 * get turned off, and they get turned off before the hour that mattered.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_BODY_CHARS, alertFor, isNewlyDangerous, truncate } from "./notify.ts";
import { parseSubscription, subscriptionId } from "./subscription.ts";

describe("isNewlyDangerous", () => {
  it("fires on the crossing into high", () => {
    assert.equal(isNewlyDangerous("low", "high"), true);
    assert.equal(isNewlyDangerous("watch", "high"), true);
    assert.equal(isNewlyDangerous(undefined, "high"), true);
  });

  it("fires on the crossing straight into confirmed", () => {
    assert.equal(isNewlyDangerous("low", "confirmed"), true);
    assert.equal(isNewlyDangerous("watch", "confirmed"), true);
  });

  /**
   * The one repeat worth sending. "Flooding is likely" and "people are
   * standing in it" are different claims, and the second is worth
   * interrupting somebody for even if the first already did.
   */
  it("fires again when likely becomes reported", () => {
    assert.equal(isNewlyDangerous("high", "confirmed"), true);
  });

  it("does not repeat while a cell stays at the same danger", () => {
    assert.equal(isNewlyDangerous("high", "high"), false);
    assert.equal(isNewlyDangerous("confirmed", "confirmed"), false);
  });

  it("does not fire on de-escalation", () => {
    assert.equal(isNewlyDangerous("confirmed", "high"), false);
    assert.equal(isNewlyDangerous("high", "watch"), false);
    assert.equal(isNewlyDangerous("high", "low"), false);
    assert.equal(isNewlyDangerous("confirmed", "low"), false);
  });

  it("never fires for a safe level, whatever came before", () => {
    for (const previous of ["low", "watch", "high", "confirmed", undefined]) {
      assert.equal(isNewlyDangerous(previous, "low"), false, `from ${String(previous)}`);
      assert.equal(isNewlyDangerous(previous, "watch"), false, `from ${String(previous)}`);
    }
  });
});

describe("alertFor", () => {
  /**
   * Observation and prediction are different claims. Somebody deciding whether
   * to leave the house deserves to know which one they have been handed.
   */
  it("separates reported flooding from likely flooding in the title", () => {
    assert.match(
      alertFor({ cell: "ebzzdyp", level: "confirmed", explanation: "x" }).title,
      /reported/,
    );
    assert.match(
      alertFor({ cell: "ebzzdyp", level: "high", explanation: "x" }).title,
      /likely/,
    );
  });

  /**
   * The same sentence the map shows. Tapping through to a differently worded
   * story is how a user decides the two disagree.
   */
  it("carries the server-authored explanation as the body", () => {
    const explanation = "Ground here is barely above the nearest drain.";
    const alert = alertFor({ cell: "ebzzdyp", level: "high", explanation });
    assert.equal(alert.body, explanation);
  });

  it("keeps the cell so the notification can open the right place", () => {
    assert.equal(alertFor({ cell: "ebzzdyp", level: "high", explanation: "x" }).cell, "ebzzdyp");
  });

  it("truncates an explanation too long for a notification", () => {
    const long = `${"Ground here is barely above the nearest drain. ".repeat(8)}`;
    const alert = alertFor({ cell: "ebzzdyp", level: "high", explanation: long });
    assert.ok(alert.body.length <= MAX_BODY_CHARS, `body was ${alert.body.length}`);
    assert.match(alert.body, /…$/);
  });
});

describe("truncate", () => {
  it("leaves a short string alone", () => {
    assert.equal(truncate("Short enough.", 50), "Short enough.");
  });

  it("cuts at a word boundary rather than mid-word", () => {
    const text = "Ground here is barely above the nearest drain and floods readily";
    const cut = truncate(text, 30);
    assert.ok(cut.length <= 30, `length ${cut.length}`);
    assert.doesNotMatch(cut, /\s…$/);
    assert.match(cut, /…$/);
  });

  it("does not leave trailing punctuation before the ellipsis", () => {
    assert.doesNotMatch(truncate("One sentence. Another sentence here.", 15), /[.,;:]…$/);
  });

  it("still truncates when there is no space to cut at", () => {
    const cut = truncate("a".repeat(100), 20);
    assert.ok(cut.length <= 20);
    assert.match(cut, /…$/);
  });
});

describe("parseSubscription", () => {
  const valid = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: "BPublicKeyValue", auth: "AuthSecret" },
  };

  it("accepts a well-formed subscription from a known push service", () => {
    assert.deepEqual(parseSubscription(valid), valid);
  });

  it("accepts the other major push services", () => {
    for (const host of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/abc",
    ]) {
      const result = parseSubscription({ ...valid, endpoint: host });
      assert.equal(typeof result, "object", `rejected ${host}`);
    }
  });

  /**
   * Without this the scoring job becomes a request generator pointed at
   * whatever URL anyone chose to register.
   */
  it("rejects an endpoint that is not a known push service", () => {
    const result = parseSubscription({ ...valid, endpoint: "https://evil.example.com/collect" });
    assert.equal(typeof result, "string");
    assert.match(result as string, /not a recognised push service/);
  });

  it("rejects a non-https endpoint", () => {
    const result = parseSubscription({ ...valid, endpoint: "http://fcm.googleapis.com/x" });
    assert.match(result as string, /must be https/);
  });

  it("rejects a host that merely contains a push service name", () => {
    const result = parseSubscription({
      ...valid,
      endpoint: "https://fcm.googleapis.com.evil.example/x",
    });
    assert.equal(typeof result, "string");
  });

  it("rejects a missing or malformed body", () => {
    assert.equal(typeof parseSubscription(null), "string");
    assert.equal(typeof parseSubscription("nope"), "string");
    assert.equal(typeof parseSubscription({}), "string");
    assert.equal(typeof parseSubscription({ endpoint: valid.endpoint }), "string");
    assert.equal(
      typeof parseSubscription({ endpoint: valid.endpoint, keys: { p256dh: "x" } }),
      "string",
    );
  });

  it("rejects an absurdly long endpoint", () => {
    const result = parseSubscription({
      ...valid,
      endpoint: `https://fcm.googleapis.com/${"a".repeat(2000)}`,
    });
    assert.match(result as string, /too long/);
  });
});

describe("subscriptionId", () => {
  it("is stable for the same endpoint", () => {
    assert.equal(subscriptionId("https://a.example/x"), subscriptionId("https://a.example/x"));
  });

  it("differs between endpoints", () => {
    assert.notEqual(subscriptionId("https://a.example/x"), subscriptionId("https://a.example/y"));
  });

  /**
   * Re-registering the same place from the same browser must overwrite its
   * row, not add a second one, or the user is alerted twice.
   */
  it("is short and URL-safe so it can appear in a key and a log line", () => {
    const id = subscriptionId("https://fcm.googleapis.com/fcm/send/abc123");
    assert.equal(id.length, 32);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
  });

  it("does not contain the endpoint it was derived from", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/secret-token";
    assert.doesNotMatch(subscriptionId(endpoint), /secret-token/);
  });
});
