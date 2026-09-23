#!/usr/bin/env node
/**
 * Best-effort local diagnostics for Cursor "out of credits" / "AI tools unavailable".
 *
 * - No network calls.
 * - No Cursor state changes.
 * - Scans local Cursor logs + caches for any cached JSON/log lines containing
 *   usage/limits/credits signals that might explain contradictory UI ("Unlimited" vs "used all credits").
 *
 * Usage:
 *   node ./scripts/diagnose-cursor-credits.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CURSOR_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "Cursor");

const KEYWORDS_TEXT = [
  "AI tools are currently unavailable",
  "used all credits",
  "billing cycle",
  "AI Credits",
  "on-demand",
  "on_demand",
  "credits",
  "credit",
  "usage",
  "limit",
  "limits",
  "quota",
  "rate limit",
  "ratelimit",
  "429",
  "402",
  "cursor.com",
  "anysphere",
];

const KEYWORDS_BYTES = KEYWORDS_TEXT.map((k) => Buffer.from(k, "utf8"));

const REDACTIONS = [
  {
    rx: /(Authorization:\s*Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    repl: "$1<redacted>",
  },
  {
    // JWT-ish
    rx: /([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    repl: "<redacted-jwt>",
  },
];

function redact(s) {
  let out = s;
  for (const { rx, repl } of REDACTIONS) out = out.replace(rx, repl);
  return out;
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function printSection(title) {
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

function* walkFiles(root, { exts = null, maxFiles = null } = {}) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(p, e));
      continue;
    }
    if (!st.isFile()) continue;
    if (exts && !exts.has(path.extname(p).toLowerCase())) continue;
    yield { filePath: p, size: st.size };
    count++;
    if (maxFiles != null && count >= maxFiles) return;
  }
}

function latestLogsDir() {
  const logsRoot = path.join(CURSOR_SUPPORT_DIR, "logs");
  let entries = [];
  try {
    entries = fs.readdirSync(logsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((d) => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
    .map((d) => path.join(logsRoot, d.name));
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function grepLogsForKeywords(rootDir) {
  const rx = new RegExp(KEYWORDS_TEXT.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const hits = [];
  for (const { filePath } of walkFiles(rootDir, { exts: new Set([".log"]) })) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!rx.test(line)) continue;
      hits.push({ filePath, lineNo: i + 1, snippet: redact(line) });
      if (hits.length >= 400) return hits;
    }
  }
  return hits;
}

function scanBinaryForKeywords(rootDir, { maxFileBytes = 20_000_000, maxHits = 120, includeExts = null, maxFiles = 6000 } = {}) {
  const hits = [];
  for (const { filePath, size } of walkFiles(rootDir, { exts: includeExts, maxFiles })) {
    if (size <= 0 || size > maxFileBytes) continue;
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      continue;
    }

    let bestIdx = -1;
    let bestKey = null;
    const lower = buf.toString("latin1").toLowerCase(); // cheap-ish for search, preserves bytes 0-255
    for (const k of KEYWORDS_BYTES) {
      const kk = k.toString("latin1").toLowerCase();
      const idx = lower.indexOf(kk);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestKey = k.toString("utf8");
      }
    }
    if (bestIdx === -1) continue;

    // Window around match (byte-ish). Use latin1 slice and then best-effort cleanup.
    const start = Math.max(0, bestIdx - 200);
    const end = Math.min(lower.length, bestIdx + 900);
    let snip = lower.slice(start, end);
    snip = snip.replace(/\u0000/g, "");
    snip = snip.replace(/[\r\n\t]+/g, " ");
    snip = snip.replace(/\s{2,}/g, " ").trim();
    snip = redact(snip);
    hits.push({ filePath, match: bestKey, snippet: snip });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

function main() {
  console.log("diagnose-cursor-credits.mjs");
  console.log(`now: ${nowIso()}`);
  console.log(`cursor_support_dir: ${CURSOR_SUPPORT_DIR}`);

  if (!fs.existsSync(CURSOR_SUPPORT_DIR)) {
    console.error("ERROR: Cursor support directory not found.");
    process.exit(2);
  }

  const logsDir = latestLogsDir();
  console.log(`latest_logs_dir: ${logsDir ?? "<none>"}`);

  if (logsDir) {
    printSection("LOG SCAN (latest bundle)");
    const hits = grepLogsForKeywords(logsDir);
    if (!hits.length) {
      console.log("No keyword hits found in .log files.");
    } else {
      for (const h of hits.slice(0, 200)) {
        console.log(`${h.filePath}:${h.lineNo}\n  ${h.snippet}\n`);
      }
      if (hits.length > 200) console.log(`... truncated (${hits.length} total hits)`);
    }
  }

  const cacheRoots = [
    { label: "Service Worker database", dir: path.join(CURSOR_SUPPORT_DIR, "Service Worker"), includeExts: null, maxFiles: 5000 },
    { label: "Cache/Cache_Data", dir: path.join(CURSOR_SUPPORT_DIR, "Cache", "Cache_Data"), includeExts: null, maxFiles: 5000 },
    { label: "CachedData", dir: path.join(CURSOR_SUPPORT_DIR, "CachedData"), includeExts: null, maxFiles: 3000 },
    {
      label: "User/workspaceStorage (text files only)",
      dir: path.join(CURSOR_SUPPORT_DIR, "User", "workspaceStorage"),
      includeExts: new Set([".json", ".txt", ".log"]),
      maxFiles: 8000,
    },
  ];

  for (const r of cacheRoots) {
    if (!fs.existsSync(r.dir)) continue;
    printSection(`BINARY SCAN (${r.label}) — ${r.dir}`);
    const hits = scanBinaryForKeywords(r.dir, { includeExts: r.includeExts, maxFiles: r.maxFiles });
    if (!hits.length) {
      console.log("No keyword hits found.");
      continue;
    }
    for (const h of hits.slice(0, 80)) {
      console.log(`${h.filePath}\n  (match:${h.match}) ${h.snippet}\n`);
    }
    if (hits.length > 80) console.log(`... truncated (${hits.length} total hits)`);
  }

  printSection("DONE");
  console.log("If you still see the banner, the most definitive check remains DevTools → Network on the Cursor Limits page.");
}

main();

