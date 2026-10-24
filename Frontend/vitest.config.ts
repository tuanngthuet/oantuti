import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Isolate modules between tests to prevent mock leakage
    isolate: true,
    // Suppress verbose output in CI
    reporters: process.env.CI ? ["dot"] : ["verbose"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
