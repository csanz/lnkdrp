/**
 * Shrink a PDF before the MCP server sends it, when shrinking is safe and worth it.
 *
 * Why this exists: the inline path (`fileBase64` / `filePath`) carries the file as a JSON request
 * body, and a serverless deployment caps request bodies far below the app's own
 * `UPLOAD_MAX_BYTES` — Vercel Functions at 4.5MB, with base64 costing ~4/3 on top. Most real decks
 * are big because of screenshots stored at print resolution, not because of their text, so
 * downsampling the images routinely takes a 3-4MB deck under 1MB with no visible loss. That turns
 * "too big to send inline" into "sent", which is the whole point.
 *
 * How it stays safe:
 *   - Ghostscript is the engine (the pragmatic route: it is one process, no npm dependency, and
 *     genuinely good at this), but it is NOT assumed to exist. If no `gs` binary is found, or the
 *     run fails, or it times out, optimization is skipped and the ORIGINAL bytes are used.
 *   - The output is only accepted if it is a valid PDF, is meaningfully smaller, AND has exactly
 *     the same number of pages as the input. A silently truncated document is far worse than a
 *     large one, so anything that cannot be verified falls back to the original.
 *   - Nothing here can fail the caller's tool call: every outcome is "bytes to send" plus a note.
 *
 * The decisions (`shouldOptimize`, `decideOptimizedBytes`) are pure and unit-tested; only
 * `optimizePdf` touches the filesystem and spawns a process.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { log } from "./config";

/**
 * Below this, leave the file alone. A small PDF is already well inside every body limit, and the
 * Ghostscript round-trip costs a process spawn plus a re-encode of every image for no useful gain.
 */
export const OPTIMIZE_MIN_BYTES = 1024 * 1024;

/**
 * The smallest saving worth accepting. A 1% win is not worth re-encoding every image in the
 * document (Ghostscript rewrites the whole file, so even a "no-op" run is a lossy round-trip);
 * below this the original is kept as-is.
 */
export const OPTIMIZE_MIN_SAVING_RATIO = 0.05;

/** How long Ghostscript gets before it is killed and the original is used. */
export const OPTIMIZE_TIMEOUT_MS = 120_000;

/** What optimization did, as reported back to the agent in the tool result. */
export type OptimizeReport = {
  /** Original size in bytes. */
  from: number;
  /** Size actually sent, in bytes. */
  to: number;
  /** `to / from`, rounded to two decimals — 0.23 means "23% of the original size". */
  ratio: number;
  /** The engine that did it. Only Ghostscript today. */
  tool: "ghostscript";
};

/** The bytes to send, plus what happened on the way there. */
export type OptimizeOutcome = {
  bytes: Buffer;
  /** Filled in when the smaller file is the one being sent; `null` when the original is. */
  optimized: OptimizeReport | null;
  /** Always set when `optimized` is null: why the original is being sent unchanged. */
  note: string | null;
};

/**
 * Whether to attempt optimization at all, before any process is spawned.
 *
 * Two reasons to skip, both cheap to decide: the caller asked not to (`optimize: false`), or the
 * file is already small enough that the round-trip cannot pay for itself.
 */
export function shouldOptimize(input: { sizeBytes: number; requested: boolean }): { run: boolean; reason: string | null } {
  if (!input.requested) return { run: false, reason: "optimize: false was passed, so the file was sent as-is." };
  if (input.sizeBytes < OPTIMIZE_MIN_BYTES) {
    return {
      run: false,
      reason: `the file is already under ${Math.round(OPTIMIZE_MIN_BYTES / 1024)}KB, so it was sent as-is.`,
    };
  }
  return { run: true, reason: null };
}

/**
 * Decide whether the smaller file may be used, given both sizes and both page counts.
 *
 * The page comparison is the load-bearing part. Ghostscript can and does emit a shorter document
 * when it chokes on something partway through, and it reports success while doing it; the size
 * then looks like a spectacular win. So a page count that differs — or one that could not be read
 * at all, on either side — means the original is kept. Losing a page silently is the one failure
 * mode that would actually hurt the human, and it is not worth a smaller upload.
 */
export function decideOptimizedBytes(input: {
  originalBytes: number;
  optimizedBytes: number;
  originalPages: number | null;
  optimizedPages: number | null;
  minSavingRatio?: number;
}): { use: "optimized"; ratio: number } | { use: "original"; reason: string } {
  const minSaving = input.minSavingRatio ?? OPTIMIZE_MIN_SAVING_RATIO;
  if (input.optimizedBytes <= 0) {
    return { use: "original", reason: "the optimizer produced an empty file" };
  }
  if (input.originalPages === null || input.optimizedPages === null) {
    return { use: "original", reason: "the page count could not be verified on both files" };
  }
  if (input.originalPages !== input.optimizedPages) {
    return {
      use: "original",
      reason: `the optimizer changed the page count (${input.originalPages} → ${input.optimizedPages})`,
    };
  }
  const ratio = input.optimizedBytes / input.originalBytes;
  if (ratio > 1 - minSaving) {
    return {
      use: "original",
      reason:
        input.optimizedBytes >= input.originalBytes
          ? "the optimized file was not smaller"
          : `the optimized file saved less than ${Math.round(minSaving * 100)}%`,
    };
  }
  return { use: "optimized", ratio: Math.round(ratio * 100) / 100 };
}

/** True when the bytes start with the `%PDF-` signature. Never trust a filename or an exit code. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Ghostscript binaries to try, in order.
 *
 * `LNKDRP_GHOSTSCRIPT` wins when set (an explicit path on a machine where `gs` is not on PATH —
 * a GUI-launched MCP server often inherits a bare PATH). Then plain `gs`, then the usual Homebrew
 * and system locations, because a server started from a desktop app frequently has none of them.
 */
export function ghostscriptCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.LNKDRP_GHOSTSCRIPT || "").trim();
  const candidates = [explicit, "gs", "/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"];
  return candidates.filter((c, i) => c.length > 0 && candidates.indexOf(c) === i);
}

/** Run a command, resolving `{ ok }` instead of throwing. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (!err) return resolve({ ok: true, error: null });
      resolve({ ok: false, error: err.message });
    });
  });
}

let _gsPath: string | null | undefined;

/**
 * Locate a working Ghostscript, or null when there is none. Cached per process: the answer cannot
 * change while the server runs, and probing costs a spawn.
 */
export async function findGhostscript(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (_gsPath !== undefined) return _gsPath;
  for (const candidate of ghostscriptCandidates(env)) {
    const res = await run(candidate, ["--version"], 10_000);
    if (res.ok) {
      _gsPath = candidate;
      return candidate;
    }
  }
  _gsPath = null;
  return null;
}

/** Forget the cached Ghostscript lookup (tests). */
export function resetGhostscriptCache(): void {
  _gsPath = undefined;
}

/**
 * Count a PDF's pages with pdfjs (already a dependency of this repo, used by the app's own
 * processing pipeline). Returns null when the file cannot be parsed — which
 * `decideOptimizedBytes` treats as "cannot verify", i.e. keep the original.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument?: (opts: unknown) => { promise: Promise<{ numPages: number; destroy?: () => Promise<unknown> }> };
      default?: { getDocument?: (opts: unknown) => { promise: Promise<{ numPages: number; destroy?: () => Promise<unknown> }> } };
    };
    const getDocument = typeof mod.getDocument === "function" ? mod.getDocument : mod.default?.getDocument;
    if (typeof getDocument !== "function") return null;
    // pdfjs detaches the buffer it is handed, so give it a copy.
    const doc = await getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false }).promise;
    const pages = doc.numPages;
    await doc.destroy?.().catch(() => undefined);
    return Number.isFinite(pages) && pages > 0 ? pages : null;
  } catch {
    return null;
  }
}

/** Image resolution the optimizer downsamples to, overridable with LNKDRP_PDF_OPTIMIZE_DPI. */
export const OPTIMIZE_IMAGE_DPI = 220;

/** Read the configured dpi, clamped to a sane range; anything unparseable falls back to the default. */
export function optimizeImageDpi(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LNKDRP_PDF_OPTIMIZE_DPI);
  if (!Number.isFinite(raw)) return OPTIMIZE_IMAGE_DPI;
  return Math.min(600, Math.max(72, Math.round(raw)));
}

/**
 * Ghostscript arguments for "same document, smaller images".
 *
 * `/printer` at 220dpi, not `/ebook` at 150: the first pass shrank a deck to a fifth of its size
 * and the owner found the images too soft (2026-09-17). This still roughly halves a photo-heavy
 * deck while keeping slides crisp on a laptop screen and in a normal print. The explicit
 * `Downsample*` settings pin the resolutions rather than relying on the preset's defaults, which
 * vary between Ghostscript releases, and `ColorImageDownsampleThreshold=1.0` downsamples anything
 * above the target instead of only images far above it. `-dSAFER` because the input is a file the
 * caller named, and `-dNOPAUSE -dBATCH -dQUIET` so it never waits for a console that is not there.
 */
export function ghostscriptArgs(input: { inputPath: string; outputPath: string; dpi?: number }): string[] {
  const dpi = input.dpi ?? optimizeImageDpi();
  return [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.5",
    "-dPDFSETTINGS=/printer",
    "-dDownsampleColorImages=true",
    `-dColorImageResolution=${dpi}`,
    "-dColorImageDownsampleThreshold=1.0",
    "-dDownsampleGrayImages=true",
    `-dGrayImageResolution=${dpi}`,
    "-dGrayImageDownsampleThreshold=1.0",
    "-dDownsampleMonoImages=true",
    "-dMonoImageResolution=600",
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=true",
    "-dNOPAUSE",
    "-dBATCH",
    "-dQUIET",
    "-dSAFER",
    `-sOutputFile=${input.outputPath}`,
    input.inputPath,
  ];
}

/**
 * Try to shrink `bytes`. Always resolves with something safe to send.
 *
 * On every failure path — no Ghostscript, a failed or timed-out run, an invalid or larger output,
 * a changed page count — the original bytes come back with `optimized: null` and a `note` the tool
 * can pass to the human.
 */
export async function optimizePdf(
  bytes: Buffer,
  opts: { requested?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<OptimizeOutcome> {
  const env = opts.env ?? process.env;
  const gate = shouldOptimize({ sizeBytes: bytes.byteLength, requested: opts.requested !== false });
  if (!gate.run) return { bytes, optimized: null, note: gate.reason };

  const gs = await findGhostscript(env);
  if (!gs) {
    return { bytes, optimized: null, note: "Ghostscript (gs) is not installed on the MCP server, so the file was sent as-is." };
  }

  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "lnkdrp-optimize-"));
    const inputPath = path.join(dir, "in.pdf");
    const outputPath = path.join(dir, "out.pdf");
    await fs.writeFile(inputPath, bytes);

    const res = await run(gs, ghostscriptArgs({ inputPath, outputPath }), OPTIMIZE_TIMEOUT_MS);
    if (!res.ok) {
      log("optimize: ghostscript failed", res.error);
      return { bytes, optimized: null, note: "Ghostscript could not process the file, so the original was sent." };
    }

    let out: Buffer;
    try {
      out = await fs.readFile(outputPath);
    } catch {
      return { bytes, optimized: null, note: "Ghostscript produced no output, so the original was sent." };
    }
    if (!looksLikePdf(out)) {
      return { bytes, optimized: null, note: "Ghostscript's output was not a valid PDF, so the original was sent." };
    }

    const [originalPages, optimizedPages] = await Promise.all([pdfPageCount(bytes), pdfPageCount(out)]);
    const decision = decideOptimizedBytes({
      originalBytes: bytes.byteLength,
      optimizedBytes: out.byteLength,
      originalPages,
      optimizedPages,
    });
    if (decision.use === "original") {
      return { bytes, optimized: null, note: `The original was sent unchanged: ${decision.reason}.` };
    }
    return {
      bytes: out,
      optimized: { from: bytes.byteLength, to: out.byteLength, ratio: decision.ratio, tool: "ghostscript" },
      note: null,
    };
  } catch (err) {
    log("optimize: failed", err instanceof Error ? err.message : err);
    return { bytes, optimized: null, note: "Optimization failed, so the original was sent." };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
