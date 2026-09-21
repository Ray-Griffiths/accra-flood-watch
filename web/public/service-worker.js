/*
 * Skeleton service worker.
 *
 * Today it caches only the application shell, so the app opens and shows
 * something useful with no connection. It deliberately does NOT cache
 * /api/* responses yet: stale risk data shown without a staleness label
 * would be worse than no data at all. Cached risk data with an explicit
 * "last updated" label arrives alongside the map.
 */

const SHELL_CACHE = "afw-shell-v1";
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

  // The API is always network-first with no fallback. A flood warning must
  // never be answered from a cache without the user being told it is old.
  if (url.pathname.startsWith("/api/")) return;

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
