import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Hashed filenames get long immutable caching at upload time; index.html
    // and the service worker get no-cache so users receive updates promptly.
    assetsDir: "assets",
    sourcemap: true,
    target: "es2020",
  },
  server: {
    proxy: {
      // Mirrors the CloudFront /api/* behaviour so dev and prod share one
      // same-origin code path and neither needs CORS handling.
      "/api": {
        target: process.env.VITE_API_ORIGIN ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
