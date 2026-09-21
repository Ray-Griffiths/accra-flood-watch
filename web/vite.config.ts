import { defineConfig, type ProxyOptions } from "vite";

/**
 * Both local servers stand in for the two CloudFront behaviours, so that
 * development, `vite preview` and production all share one same-origin code
 * path. Nothing needs CORS, and the tile-rewriting in map.ts is exercised
 * locally rather than first discovered in production.
 */
const proxy: Record<string, ProxyOptions> = {
  "/api": {
    target: process.env.VITE_API_ORIGIN ?? "http://localhost:3000",
    changeOrigin: true,
  },
  // Amazon Location tiles, glyphs and sprites. The client rewrites every
  // absolute maps.geo URL to this origin so the requests travel through the
  // edge cache in production; without the same target locally the map would
  // simply have no tiles.
  "/v2": {
    target: process.env.VITE_MAPS_ORIGIN ?? "https://maps.geo.eu-west-1.amazonaws.com",
    changeOrigin: true,
  },
};

export default defineConfig({
  build: {
    // Hashed filenames get long immutable caching at upload time; index.html
    // and the service worker get no-cache so users receive updates promptly.
    assetsDir: "assets",
    sourcemap: true,
    target: "es2020",
  },
  server: { proxy },
  preview: { proxy },
});
