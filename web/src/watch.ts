/**
 * Watching a place: the browser half.
 *
 * The user picks a spot on the map and asks to be told if it floods. What
 * leaves the device is a cell coordinate and the opaque push subscription the
 * browser generated. No account, no name, no device identifier, and nothing
 * that links two watched places together beyond the subscription the push
 * service already knows about.
 *
 * The permission prompt is deliberately not shown on load. A notification
 * prompt that appears before anybody has asked for anything is denied, and a
 * denial is permanent until the user goes digging in browser settings. So the
 * prompt only follows an explicit tap on "Alert me about this place", by which
 * point the request has an obvious reason attached to it.
 */

import { saveWatch, type WatchResult } from "./api.ts";

export type WatchSupport =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * Can this browser do push at all, and is the server configured for it?
 *
 * Checked before any control is offered. Offering a button that fails after
 * the user has already granted a permission is worse than not offering one.
 */
export function checkSupport(publicKey: string | null | undefined): WatchSupport {
  if (!publicKey) {
    return { supported: false, reason: "Alerts are not switched on for this service yet." };
  }
  if (!("serviceWorker" in navigator)) {
    return { supported: false, reason: "This browser cannot receive alerts." };
  }
  if (!("PushManager" in window)) {
    return { supported: false, reason: "This browser cannot receive alerts." };
  }
  if (!("Notification" in window)) {
    return { supported: false, reason: "This browser cannot show alerts." };
  }
  if (Notification.permission === "denied") {
    return {
      supported: false,
      reason: "Alerts are blocked for this site. You can turn them back on in browser settings.",
    };
  }
  return { supported: true };
}

/**
 * The applicationServerKey has to be raw bytes, and the server sends base64url.
 *
 * Padding matters: `atob` rejects a string whose length is not a multiple of
 * four, and base64url strips the padding that would have made it one.
 */
function decodeKey(base64url: string): Uint8Array {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Get the browser's push subscription, creating it if this is the first time.
 *
 * Reuses an existing subscription rather than replacing it: a browser has one
 * per service worker registration, and re-subscribing would invalidate the
 * endpoint every other watched place is stored under.
 */
async function getSubscription(publicKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    // Required by Chrome, and the honest setting regardless: every message
    // this service sends carries content the user is meant to read.
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey) as BufferSource,
  });
}

function toJson(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const raw = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  return {
    endpoint: raw.endpoint ?? subscription.endpoint,
    keys: { p256dh: raw.keys?.p256dh ?? "", auth: raw.keys?.auth ?? "" },
  };
}

/**
 * Ask to be alerted about a place.
 *
 * Throws with a readable message on refusal, so the caller can put the reason
 * in front of the user rather than a silent no-op.
 */
export async function watchPlace(
  latitude: number,
  longitude: number,
  publicKey: string,
): Promise<WatchResult> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      "Alerts need notification permission. Nothing was saved — you can try again any time.",
    );
  }

  const subscription = await getSubscription(publicKey);
  return saveWatch(latitude, longitude, toJson(subscription), "watch");
}

// ---------------------------------------------------------------------------
// Remembering which places this browser watches
// ---------------------------------------------------------------------------

/**
 * The server holds the authoritative list, keyed by cell, but it cannot be
 * asked "what does this browser watch" -- that query would need an index by
 * subscription, which is exactly the shape the privacy design refuses. So the
 * browser keeps its own list purely to draw the button in the right state.
 *
 * Losing it is harmless: the watch still exists server-side and still fires.
 * The button just reads "Alert me" until the user taps it again, which
 * re-registers the same row rather than adding a second one.
 */
const WATCHED_KEY = "afw.watched.v1";

export function watchedCells(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberWatch(cell: string, watching: boolean): void {
  try {
    const cells = watchedCells();
    if (watching) cells.add(cell);
    else cells.delete(cell);
    localStorage.setItem(WATCHED_KEY, JSON.stringify([...cells]));
  } catch {
    /* Private browsing or a full quota. The watch itself is unaffected. */
  }
}

/** Stop being alerted about a place. The subscription itself is left alone. */
export async function unwatchPlace(
  latitude: number,
  longitude: number,
): Promise<WatchResult | null> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  // Nothing to cancel: there was never a subscription to register under.
  if (!subscription) return null;

  return saveWatch(latitude, longitude, toJson(subscription), "unwatch");
}
