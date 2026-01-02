import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/agent/**/*.test.ts"],
    setupFiles: ["tests/agent/vitest.setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["default"],
  },
});


