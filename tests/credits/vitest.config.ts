import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  envDir: "./tmp",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../src"),
    },
  },
  test: {
    environment: "node",
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    include: ["tests/credits/**/*.test.ts"],
    reporters: ["default"],
  },
});


