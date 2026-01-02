#!/usr/bin/env node
/**
 * Render a PDF page to a PNG.
 *
 * Uses PDF.js (`pdfjs-dist`) which is a popular PDF rendering library.
 *
 * Usage:
 *   node scripts/pdf-first-page-to-png.mjs <pdfPathOrUrl> [outputPngPath] [--scale 2] [--page 1]
 *
 * Examples:
 *   node scripts/pdf-first-page-to-png.mjs public/sample/usavx.pdf
 *   node scripts/pdf-first-page-to-png.mjs public/sample/usavx.pdf ./tmp/usavx-page1.png
 *   node scripts/pdf-first-page-to-png.mjs https://example.com/file.pdf ./out.png --scale 2.5
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createCanvas } from "@napi-rs/canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Best-effort PNG recompression (lossless) to reduce file size.
 *
 * Uses `sharp` if available, but does not require it.
 */
async function optimizePngLossless(pngBuffer) {
  // `sharp` is optional at runtime; if present, use it to recompress PNG losslessly.
  try {
    const mod = await import("sharp");
    const sharp = mod.default ?? mod;
    return await sharp(pngBuffer)
      .png({
        compressionLevel: 9, // max DEFLATE compression (lossless)
        adaptiveFiltering: true,
      })
      .toBuffer();
  } catch {
    return pngBuffer;
  }
}

/**
 * Print usage instructions for pdf-first-page-to-png.mjs and exit.
 */
function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/pdf-first-page-to-png.mjs <pdfPathOrUrl> [outputPngPath] [--scale <number>] [--page <number>] [--maxWidth <px>]

Notes:
  - <pdfPathOrUrl> can be a local filesystem path or an http(s) URL.
  - If outputPngPath is omitted, writes to ./tmp/<inputBase>-page<page>.png
  - Writes a sibling JSON file containing the image dimensions.
  - Default --page is 1, default --scale is 2.
  - Default --maxWidth is 1200 (good for Open Graph).
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Parse CLI arguments.
 */
function parseArgs(argv) {
  const args = [...argv];
  const positionals = [];
  let scale = 2;
  let page = 1;
  let maxWidth = 1200;

  while (args.length) {
    const a = args.shift();
    if (!a) break;

    if (a === "--help" || a === "-h") usage(0);

    if (a === "--scale") {
      const v = args.shift();
      if (!v) usage(1);
      scale = Number(v);
      continue;
    }

    if (a.startsWith("--scale=")) {
      scale = Number(a.slice("--scale=".length));
      continue;
    }

    if (a === "--page") {
      const v = args.shift();
      if (!v) usage(1);
      page = Number(v);
      continue;
    }

    if (a.startsWith("--page=")) {
      page = Number(a.slice("--page=".length));
      continue;
    }

    if (a === "--maxWidth") {
      const v = args.shift();
      if (!v) usage(1);
      maxWidth = Number(v);
      continue;
    }

    if (a.startsWith("--maxWidth=")) {
      maxWidth = Number(a.slice("--maxWidth=".length));
      continue;
    }

    if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage(1);
    }

    positionals.push(a);
  }

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid --scale: ${scale}`);
  }
  if (!Number.isInteger(page) || page <= 0) {
    throw new Error(`Invalid --page: ${page}`);
  }
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new Error(`Invalid --maxWidth: ${maxWidth}`);
  }

  if (positionals.length < 1) usage(1);
  const [input, output] = positionals;
  return { input, output, scale, page, maxWidth };
}

/**
 * Determine a default output PNG path under ./tmp from the input.
 */
function defaultOutputPathForInput(input, page) {
  // If input is a URL, use the last path segment (sans extension) for naming.
  const base =
    isUrl(input) ? path.basename(new URL(input).pathname) : path.basename(input);
  const name = base.replace(/\.[^/.]+$/, "") || "document";
  return path.join("tmp", `${name}-page${page}.png`);
}

/**
 * Return true when the input string is an http(s) URL.
 */
function isUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Read PDF bytes from either a URL (download) or a local filesystem path.
 */
async function readPdfBytes(input) {
  if (isUrl(input)) {
    const res = await fetch(input);
    if (!res.ok) {
      throw new Error(`Failed to download PDF (${res.status} ${res.statusText}): ${input}`);
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  const buf = await fs.readFile(input);
  return new Uint8Array(buf);
}

/**
 * Ensure the output directory exists.
 */
async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Run pdf-first-page-to-png.mjs: Render a PDF page to a PNG.
 */
async function main() {
  const { input, output, scale, page, maxWidth } = parseArgs(process.argv.slice(2));
  const outputPath = output ?? defaultOutputPathForInput(input, page);
  const { dir: outputDir, name: outputBase } = path.parse(outputPath);
  const jsonPath = path.join(outputDir, `${outputBase}.json`);

  const data = await readPdfBytes(input);

  // In Node, run PDF.js without spawning a worker.
  const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
  const pdf = await loadingTask.promise;

  if (page > pdf.numPages) {
    throw new Error(`Requested --page ${page}, but PDF only has ${pdf.numPages} pages`);
  }

  const pdfPage = await pdf.getPage(page);
  const baseViewport = pdfPage.getViewport({ scale });
  const finalScale =
    baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
  const viewport = pdfPage.getViewport({ scale: finalScale });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  await pdfPage
    .render({
      canvasContext: ctx,
      viewport,
    })
    .promise;

  await ensureParentDir(outputPath);
  const pngRaw = canvas.toBuffer("image/png");
  const pngOptimized = await optimizePngLossless(pngRaw);
  await fs.writeFile(outputPath, pngOptimized);

  const kb = (bytes) => Number((bytes / 1024).toFixed(1));

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        input,
        page,
        scaleRequested: scale,
        scaleUsed: Number(finalScale.toFixed(6)),
        maxWidth,
        width,
        height,
        outputPng: outputPath,
        bytes: {
          raw: pngRaw.length,
          optimized: pngOptimized.length,
          rawKB: kb(pngRaw.length),
          optimizedKB: kb(pngOptimized.length),
        },
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`Wrote ${outputPath} (${width}x${height})`);
  console.log(`Wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




