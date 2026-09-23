#!/usr/bin/env node
/**
 * Run the JXA browser inspector and print JSON.
 *
 * Usage:
 *   node ./scripts/check-cursor-web-limits.mjs
 *
 * Prereqs:
 * - Open the Cursor Limits page in a browser tab.
 * - Keep that tab focused/active.
 *
 * Notes:
 * - No network calls, no state changes; it only reads the active tab.
 * - Uses macOS `osascript`, so this only works on macOS.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const jxaPath = path.join(__dirname, "check-cursor-web-limits.jxa");

try {
  const out = execFileSync("osascript", ["-l", "JavaScript", jxaPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(out);
} catch (err) {
  const stderr = err?.stderr ? String(err.stderr) : "";
  const msg = stderr || (err?.message ? String(err.message) : String(err));
  process.stderr.write(msg.trimEnd() + "\n");
  process.exit(1);
}

