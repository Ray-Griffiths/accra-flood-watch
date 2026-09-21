/**
 * Push subscriptions, and the identifier they are stored under.
 *
 * The privacy rule is that a saved location keys off the browser's opaque push
 * subscription, never a person. The endpoint URL the browser hands out is
 * already that opaque thing, but it is long, it is unique to a device, and it
 * would end up in log lines and error messages if it were the sort key. So the
 * sort key is a hash of it.
 *
 * That is not a security measure -- the endpoint itself has to be stored
 * alongside, or nothing could be sent. It is a blast-radius measure: the key
 * that appears in metrics, traces and error strings is not the thing that can
 * be used to push to somebody's phone.
 */

import { createHash } from "node:crypto";

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Push services in current use. Anything else is not accepted. */
const ALLOWED_ENDPOINT_HOSTS = [
  /\.google\.com$/,
  /\.googleapis\.com$/,
  /\.mozilla\.com$/,
  /\.mozaws\.net$/,
  /\.windows\.com$/,
  /\.microsoft\.com$/,
  /\.apple\.com$/,
];

/**
 * Validate a subscription handed up by a browser.
 *
 * The endpoint is a URL this service will later make requests to, so it is
 * checked rather than trusted: without a host allow-list, anyone could
 * register an arbitrary URL and turn the scoring job into a request generator
 * pointed wherever they liked.
 */
export function parseSubscription(value: unknown): PushSubscription | string {
  if (typeof value !== "object" || value === null) {
    return "subscription is required.";
  }

  const raw = value as { endpoint?: unknown; keys?: unknown };
  if (typeof raw.endpoint !== "string" || raw.endpoint.length === 0) {
    return "subscription.endpoint is required.";
  }
  if (raw.endpoint.length > 1024) {
    return "subscription.endpoint is too long.";
  }

  let url: URL;
  try {
    url = new URL(raw.endpoint);
  } catch {
    return "subscription.endpoint must be a URL.";
  }
  if (url.protocol !== "https:") {
    return "subscription.endpoint must be https.";
  }
  if (!ALLOWED_ENDPOINT_HOSTS.some((pattern) => pattern.test(url.hostname))) {
    return "subscription.endpoint is not a recognised push service.";
  }

  const keys = raw.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") {
    return "subscription.keys.p256dh and subscription.keys.auth are required.";
  }
  if (keys.p256dh.length > 256 || keys.auth.length > 256) {
    return "subscription.keys are malformed.";
  }

  return { endpoint: raw.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * The stable, opaque sort key for a subscription.
 *
 * Deterministic, so the same browser re-registering the same place overwrites
 * its row rather than accumulating duplicates and being alerted twice.
 */
export function subscriptionId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("base64url").slice(0, 32);
}
