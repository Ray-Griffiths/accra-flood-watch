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

const SHELL_CACHE = "afw-shell-v2";
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

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/v2/")) return;

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
