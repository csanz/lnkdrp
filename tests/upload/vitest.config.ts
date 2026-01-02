import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  // In this repo, `.env.local` is typically gitignored. Cursor's sandbox may block
  // access to ignored files, so point Vite's env loader at a safe directory.
  envDir: "./tmp",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../src"),
    },
  },
  test: {
    environment: "node",
    // Avoid sandbox restrictions around child process signals by forcing worker threads
    // and running tests in a single thread for determinism.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    include: ["tests/upload/**/*.test.ts"],
    reporters: ["default"],
  },
});


