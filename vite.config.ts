import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the build works on GitHub Pages project URLs.
  base: "./",
  build: {
    // The Rapier "compat" package inlines its ~2 MB wasm as base64.
    chunkSizeWarningLimit: 2500,
  },
  test: {
    testTimeout: 60_000,
  },
});
