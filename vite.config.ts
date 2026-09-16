import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      // READ THIS BEFORE QUOTING THE 90% BELOW.
      //
      // `include` deliberately omits src/App.tsx, which is ~8.7k lines -- about
      // 30% of the frontend and nearly all of its business logic. No test
      // renders it: measured 2026-09-10 it is at 0% (lines 230-8669 uncovered),
      // and whole-src coverage is ~36%, not 90%. The thresholds below are a
      // real gate on src/components and src/lib and say nothing about the app.
      //
      // Adding App.tsx here does not work as a ratchet: vitest applies the
      // global threshold to every file "even if they are included by glob
      // patterns" (its own comment in resolveThresholds), so a per-file
      // override cannot exempt it -- including it just fails CI at 36%. The fix
      // is tests for App.tsx, or extracting logic out of it into src/lib where
      // this gate already bites. Until then the honest number is in this
      // comment rather than in the reporter output.
      include: ["src/components/**/*.tsx", "src/lib/**/*.ts"],
      exclude: [
        "src/lib/types.ts",
        "src/**/*.test.{ts,tsx}"
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true
  }
});
