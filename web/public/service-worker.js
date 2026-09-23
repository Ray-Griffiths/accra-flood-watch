/*
 * Caches the application shell so the app opens and shows something useful
 * with no connection.
 *
 * Two deliberate exclusions:
 *
 *   /api/*  Network-first with no fallback. A flood warning must never be
 *           answered out of a cache without the user being told it is old.
 *           Last-known risk IS kept, but in localStorage by cache.ts, which
 *           hands it back with an age label the interface is required to
 *           print. Serving it invisibly from here would strip that label.
 *
 *   /v2/*   Amazon Location tiles, glyphs and sprites. They are same-origin
 *           because CloudFront proxies them, so without this they would fall
 *           into the cache-first branch below and grow without bound. Full
 *           offline tile caching is out of scope; the CloudFront edge cache
 *           is where tile caching belongs.
 */

// Bumped whenever the shell's markup changes: activate deletes every cache
// that is not this one, which is what evicts the previous index.html.
const SHELL_CACHE = "afw-shell-v3";
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/*
 * Push alerts for watched places.
 *
 * The payload is composed on the server so the wording cannot drift between a
 * notification, the map and a route explanation. This file only presents it,
 * and falls back to a generic message rather than showing nothing if the
 * payload is missing or unparseable — Chrome requires a notification for every
 * push received under userVisibleOnly, and a silent drop would be a message
 * the user never learns was sent.
 */
self.addEventListener("push", (event) => {
  let alert = {
    title: "Flooding alert",
    body: "A place you watch may be flooding. Open Accra Flood Watch to see.",
    cell: "",
  };

  try {
    if (event.data) alert = { ...alert, ...event.data.json() };
  } catch {
    /* Keep the fallback. */
  }

  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      // Collapses repeats for the same place rather than stacking them: three
      // notifications about one street is how notifications get turned off.
      tag: alert.cell ? `afw-${alert.cell}` : "afw",
      renotify: true,
      requireInteraction: false,
      data: { cell: alert.cell },
    }),
  );
});

/*
 * Tapping the alert brings the app to whatever tab is already open rather than
 * opening a second one — somebody reacting to a flood warning should not have
 * to find which of three tabs is the live map.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/v2/")) return;
  // Open data is a couple of megabytes published for download, not part of
  // the app shell. Caching it here would spend a phone's storage on a file
  // the app itself never reads.
  if (url.pathname.startsWith("/open-data/")) return;

  // Navigations: network first so updates land promptly, shell as fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Hashed static assets: cache first, they are immutable by filename.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
