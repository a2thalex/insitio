import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
  },
});
