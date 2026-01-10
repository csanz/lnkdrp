#!/usr/bin/env node
/**
 * Extract embedded images from a PDF, downsample/compress them, and print a size report.
 *
 * Default input is `tmp/USAvionix Deck.pdf`.
 *
 * Usage:
 *   node scripts/pdf-extract-images.mjs [pdfPath]
 *     [--outDir <dir>]
 *     [--maxDim <px>]
 *     [--jpegQualities <csv>]
 *     [--maxPages <n>]
 *
 * Examples:
 *   node scripts/pdf-extract-images.mjs
 *   node scripts/pdf-extract-images.mjs tmp/USAvionix\\ Deck.pdf --maxDim 1400
 *   node scripts/pdf-extract-images.mjs tmp/USAvionix\\ Deck.pdf --outDir tmp/pdf-images --jpegQualities 85,75,65
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/pdf-extract-images.mjs [pdfPath] [--outDir <dir>] [--maxDim <px>] [--jpegQualities <csv>] [--maxPages <n>]
    [--pdfPreset <screen|ebook|printer|prepress|default>]
    [--pdfDpi <n>]
    [--renderPages <0|1>]
    [--pageMaxWidth <px>]
    [--pageJpegQuality <1-100>]
    [--pageFormat <jpg|png|auto>]
    [--pageChroma <4:2:0|4:4:4>]
    [--pageSharpen <0|1>]
    [--extractEmbeddedImages <0|1>]

Defaults:
  pdfPath: tmp/USAvionix Deck.pdf
  outDir:  tmp/pdf-images
  maxDim:  1600                 (only used for embedded image extraction)
  jpegQualities: 80,70,60,50    (only used for embedded image extraction)
  pdfPreset: ebook
  pdfDpi: 150
  renderPages: 1
  pageMaxWidth: 900
  pageJpegQuality: 70
  pageFormat: jpg
  pageChroma: 4:4:4
  pageSharpen: 1
  extractEmbeddedImages: 0

Notes:
  - If --renderPages=1, writes slide "screenshots" per page:
    - pages/raw/       lossless PNG render
    - pages/optimized/ downsampled + compressed JPG/PNG
  - If --extractEmbeddedImages=1, also writes decoded embedded images:
    - embedded/raw/       lossless PNG at native resolution (decoded pixels)
    - embedded/optimized/ downsampled + compressed JPG/PNG
  - Also writes an optimized PDF into optimized/ using Ghostscript (preserves vectors/text).
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  const positionals = [];

  let outDir = path.join("tmp", "pdf-images");
  let maxDim = 1600;
  let jpegQualities = [80, 70, 60, 50];
  let maxPages = null;
  let pdfPreset = "ebook";
  let pdfDpi = 150;
  let renderPages = true;
  let pageMaxWidth = 900;
  let pageJpegQuality = 70;
  let pageFormat = "jpg";
  let pageChroma = "4:4:4";
  let pageSharpen = true;
  let extractEmbeddedImages = false;

  while (args.length) {
    const a = args.shift();
    if (!a) break;

    if (a === "--help" || a === "-h") usage(0);

    if (a === "--outDir") {
      const v = args.shift();
      if (!v) usage(1);
      outDir = v;
      continue;
    }
    if (a.startsWith("--outDir=")) {
      outDir = a.slice("--outDir=".length);
      continue;
    }

    if (a === "--maxDim") {
      const v = args.shift();
      if (!v) usage(1);
      maxDim = Number(v);
      continue;
    }
    if (a.startsWith("--maxDim=")) {
      maxDim = Number(a.slice("--maxDim=".length));
      continue;
    }

    if (a === "--jpegQualities") {
      const v = args.shift();
      if (!v) usage(1);
      jpegQualities = String(v)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100);
      continue;
    }
    if (a.startsWith("--jpegQualities=")) {
      const v = a.slice("--jpegQualities=".length);
      jpegQualities = String(v)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100);
      continue;
    }

    if (a === "--maxPages") {
      const v = args.shift();
      if (!v) usage(1);
      maxPages = Number(v);
      continue;
    }
    if (a.startsWith("--maxPages=")) {
      maxPages = Number(a.slice("--maxPages=".length));
      continue;
    }

    if (a === "--renderPages") {
      const v = args.shift();
      if (!v) usage(1);
      renderPages = v === "1" || v.toLowerCase() === "true";
      continue;
    }
    if (a.startsWith("--renderPages=")) {
      const v = a.slice("--renderPages=".length);
      renderPages = v === "1" || v.toLowerCase() === "true";
      continue;
    }

    if (a === "--pageMaxWidth") {
      const v = args.shift();
      if (!v) usage(1);
      pageMaxWidth = Number(v);
      continue;
    }
    if (a.startsWith("--pageMaxWidth=")) {
      pageMaxWidth = Number(a.slice("--pageMaxWidth=".length));
      continue;
    }

    if (a === "--pageJpegQuality") {
      const v = args.shift();
      if (!v) usage(1);
      pageJpegQuality = Number(v);
      continue;
    }
    if (a.startsWith("--pageJpegQuality=")) {
      pageJpegQuality = Number(a.slice("--pageJpegQuality=".length));
      continue;
    }

    if (a === "--pageFormat") {
      const v = args.shift();
      if (!v) usage(1);
      pageFormat = String(v).trim().toLowerCase();
      continue;
    }
    if (a.startsWith("--pageFormat=")) {
      pageFormat = String(a.slice("--pageFormat=".length)).trim().toLowerCase();
      continue;
    }

    if (a === "--pageChroma") {
      const v = args.shift();
      if (!v) usage(1);
      pageChroma = String(v).trim();
      continue;
    }
    if (a.startsWith("--pageChroma=")) {
      pageChroma = String(a.slice("--pageChroma=".length)).trim();
      continue;
    }

    if (a === "--pageSharpen") {
      const v = args.shift();
      if (!v) usage(1);
      pageSharpen = v === "1" || v.toLowerCase() === "true";
      continue;
    }
    if (a.startsWith("--pageSharpen=")) {
      const v = a.slice("--pageSharpen=".length);
      pageSharpen = v === "1" || v.toLowerCase() === "true";
      continue;
    }

    if (a === "--extractEmbeddedImages") {
      const v = args.shift();
      if (!v) usage(1);
      extractEmbeddedImages = v === "1" || v.toLowerCase() === "true";
      continue;
    }
    if (a.startsWith("--extractEmbeddedImages=")) {
      const v = a.slice("--extractEmbeddedImages=".length);
      extractEmbeddedImages = v === "1" || v.toLowerCase() === "true";
      continue;
    }

    if (a === "--pdfPreset") {
      const v = args.shift();
      if (!v) usage(1);
      pdfPreset = String(v).trim();
      continue;
    }
    if (a.startsWith("--pdfPreset=")) {
      pdfPreset = String(a.slice("--pdfPreset=".length)).trim();
      continue;
    }

    if (a === "--pdfDpi") {
      const v = args.shift();
      if (!v) usage(1);
      pdfDpi = Number(v);
      continue;
    }
    if (a.startsWith("--pdfDpi=")) {
      pdfDpi = Number(a.slice("--pdfDpi=".length));
      continue;
    }

    if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage(1);
    }

    positionals.push(a);
  }

  const pdfPath = positionals[0] ?? path.join("tmp", "USAvionix Deck.pdf");

  if (!Number.isFinite(maxDim) || maxDim <= 0) throw new Error(`Invalid --maxDim: ${maxDim}`);
  if (!jpegQualities.length) jpegQualities = [80, 70, 60, 50];
  if (maxPages != null && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    throw new Error(`Invalid --maxPages: ${maxPages}`);
  }
  if (!Number.isFinite(pdfDpi) || pdfDpi <= 0) throw new Error(`Invalid --pdfDpi: ${pdfDpi}`);
  if (!Number.isFinite(pageMaxWidth) || pageMaxWidth <= 0) throw new Error(`Invalid --pageMaxWidth: ${pageMaxWidth}`);
  if (!Number.isFinite(pageJpegQuality) || pageJpegQuality < 1 || pageJpegQuality > 100) {
    throw new Error(`Invalid --pageJpegQuality: ${pageJpegQuality}`);
  }
  if (!["jpg", "png", "auto"].includes(pageFormat)) {
    throw new Error(`Invalid --pageFormat: ${pageFormat} (use jpg|png|auto)`);
  }
  if (!["4:2:0", "4:4:4"].includes(pageChroma)) {
    throw new Error(`Invalid --pageChroma: ${pageChroma} (use 4:2:0|4:4:4)`);
  }

  const preset = pdfPreset.toLowerCase();
  const allowedPresets = new Set(["screen", "ebook", "printer", "prepress", "default"]);
  if (!allowedPresets.has(preset)) {
    throw new Error(`Invalid --pdfPreset: ${pdfPreset} (use screen|ebook|printer|prepress|default)`);
  }
  pdfPreset = preset;

  return {
    pdfPath,
    outDir,
    maxDim,
    jpegQualities,
    maxPages,
    pdfPreset,
    pdfDpi,
    renderPages,
    pageMaxWidth,
    pageJpegQuality,
    pageFormat,
    pageChroma,
    pageSharpen,
    extractEmbeddedImages,
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function safeNameForPath(p) {
  const base = path.basename(p).replace(/\.[^/.]+$/, "") || "document";
  return base.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function percentSaved(beforeBytes, afterBytes) {
  if (!beforeBytes || !afterBytes) return "";
  const saved = 1 - afterBytes / beforeBytes;
  return `${(saved * 100).toFixed(1)}%`;
}

function getChannelsFromImageKind(kind) {
  if (kind === pdfjsLib.ImageKind.GRAYSCALE_8BPP) return 1;
  if (kind === pdfjsLib.ImageKind.RGB_24BPP) return 3;
  if (kind === pdfjsLib.ImageKind.RGBA_32BPP) return 4;
  return null;
}

function asUint8Like(v) {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Uint8ClampedArray) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (ArrayBuffer.isView(v) && v.buffer) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

async function getPageObj(page, name) {
  return await new Promise((resolve) => {
    try {
      page.objs.get(name, (obj) => resolve(obj));
    } catch {
      resolve(null);
    }
  });
}

async function decodedImageToPngBuffer(img) {
  const width = img?.width;
  const height = img?.height;
  const kind = img?.kind;
  const dataView = asUint8Like(img?.data);

  if (!Number.isInteger(width) || width <= 0) return null;
  if (!Number.isInteger(height) || height <= 0) return null;
  const channels = getChannelsFromImageKind(kind);
  if (!channels) return null;
  if (!dataView) return null;

  const expectedLen = width * height * channels;
  if (dataView.byteLength < expectedLen) return null;

  const rawBuf = Buffer.from(dataView.buffer, dataView.byteOffset, expectedLen);
  return await sharp(rawBuf, { raw: { width, height, channels } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function encodeOptimized(pngBuffer, { maxDim, jpegQualities }) {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const width = meta.width ?? null;
  const height = meta.height ?? null;
  const hasAlpha = !!meta.hasAlpha;

  const resized = img.resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true });

  if (hasAlpha) {
    const out = await resized
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
        quality: 80,
      })
      .toBuffer();
    return { buffer: out, ext: "png", width, height, format: "png", detail: "alpha" };
  }

  // Try multiple JPEG qualities and pick the smallest.
  let best = null;
  for (const q of jpegQualities) {
    const buf = await resized.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (!best || buf.length < best.buffer.length) {
      best = { buffer: buf, ext: "jpg", width, height, format: "jpeg", detail: `q${q}` };
    }
  }
  return best ?? { buffer: await resized.jpeg({ quality: 70, mozjpeg: true }).toBuffer(), ext: "jpg" };
}

async function encodePageOptimized(pngBuffer, { maxWidth, jpegQuality, pageFormat, pageChroma, pageSharpen }) {
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  const hasAlpha = !!meta.hasAlpha;

  let pipeline = img.resize({ width: maxWidth, withoutEnlargement: true });
  if (pageSharpen) {
    // Mild sharpening helps slide text after downscaling without over-haloing.
    pipeline = pipeline.sharpen(0.8);
  }

  if (pageFormat === "png" || (pageFormat === "auto" && hasAlpha)) {
    const out = await pipeline
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
        quality: 80,
      })
      .toBuffer();
    return { buffer: out, ext: "png" };
  }

  // For rendered slides (often text/graphics), keep quality moderate-high to avoid artifacts.
  const out = await pipeline
    // Canvas renders may include an alpha channel; flatten to avoid forcing PNG.
    .flatten(hasAlpha ? { background: "#ffffff" } : undefined)
    .jpeg({
      quality: Math.round(jpegQuality),
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: pageChroma,
      optimiseCoding: true,
    })
    .toBuffer();
  return { buffer: out, ext: "jpg" };
}

function findExecutableOnPath(name) {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const p of parts) {
    const full = path.join(p, name);
    try {
      // eslint-disable-next-line no-sync
      const st = fsSync.statSync(full);
      if (st.isFile()) return full;
    } catch {
      // ignore
    }
  }
  return null;
}

async function runGhostscriptOptimizePdf({ gsPath, inputPdfPath, outputPdfPath, preset, dpi }) {
  const presetArg = preset === "default" ? null : `/${preset}`;

  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=true",
    "-dSubsetFonts=true",
    "-dDownsampleColorImages=true",
    "-dDownsampleGrayImages=true",
    "-dDownsampleMonoImages=true",
    "-dColorImageDownsampleType=/Bicubic",
    "-dGrayImageDownsampleType=/Bicubic",
    "-dMonoImageDownsampleType=/Subsample",
    `-dColorImageResolution=${Math.round(dpi)}`,
    `-dGrayImageResolution=${Math.round(dpi)}`,
    `-dMonoImageResolution=${Math.round(dpi)}`,
  ];

  if (presetArg) args.push(`-dPDFSETTINGS=${presetArg}`);

  args.push(`-sOutputFile=${outputPdfPath}`);
  args.push(inputPdfPath);

  await new Promise((resolve, reject) => {
    const child = spawn(gsPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(null);
      else reject(new Error(`Ghostscript failed with exit code ${code}`));
    });
  });
}

async function main() {
  const {
    pdfPath,
    outDir,
    maxDim,
    jpegQualities,
    maxPages,
    pdfPreset,
    pdfDpi,
    renderPages,
    pageMaxWidth,
    pageJpegQuality,
    pageFormat,
    pageChroma,
    pageSharpen,
    extractEmbeddedImages,
  } = parseArgs(process.argv.slice(2));

  const runDir = path.join(outDir, `${safeNameForPath(pdfPath)}-${Date.now()}`);
  const optDir = path.join(runDir, "optimized");
  await ensureDir(optDir);

  const pagesRawDir = path.join(runDir, "pages", "raw");
  const pagesOptDir = path.join(runDir, "pages", "optimized");
  if (renderPages) {
    await ensureDir(pagesRawDir);
    await ensureDir(pagesOptDir);
  }

  const embeddedRawDir = path.join(runDir, "embedded", "raw");
  const embeddedOptDir = path.join(runDir, "embedded", "optimized");
  if (extractEmbeddedImages) {
    await ensureDir(embeddedRawDir);
    await ensureDir(embeddedOptDir);
  }

  const pdfBytes = new Uint8Array(await fs.readFile(pdfPath));
  const inputPdfStat = await fs.stat(pdfPath);

  // In Node, run PDF.js without spawning a worker.
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const pagesToProcess = maxPages ? Math.min(totalPages, maxPages) : totalPages;

  const embeddedRows = [];
  const pageRows = [];
  let embeddedExtracted = 0;
  let embeddedSkipped = 0;
  let pagesRendered = 0;

  for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const opList = extractEmbeddedImages ? await page.getOperatorList() : null;

    if (renderPages) {
      // Render page to a PNG "screenshot"
      const baseViewport = page.getViewport({ scale: 2 });
      const scaleUsed = baseViewport.width > pageMaxWidth ? 2 * (pageMaxWidth / baseViewport.width) : 2;
      const viewport = page.getViewport({ scale: scaleUsed });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      const png = canvas.toBuffer("image/png");
      const pageBase = `p${String(pageNum).padStart(3, "0")}`;
      const rawPath = path.join(pagesRawDir, `${pageBase}.png`);
      await fs.writeFile(rawPath, png);
      const rawStat = await fs.stat(rawPath);

      const optimized = await encodePageOptimized(png, {
        maxWidth: pageMaxWidth,
        jpegQuality: pageJpegQuality,
        pageFormat,
        pageChroma,
        pageSharpen,
      });
      const optPath = path.join(pagesOptDir, `${pageBase}.${optimized.ext}`);
      await fs.writeFile(optPath, optimized.buffer);
      const optStat = await fs.stat(optPath);

      pagesRendered += 1;
      pageRows.push({
        page: pageNum,
        px: `${width}x${height}`,
        rawSize: fmtBytes(rawStat.size),
        optSize: fmtBytes(optStat.size),
        saved: percentSaved(rawStat.size, optStat.size),
        rawPath,
        optPath,
      });
    }

    if (extractEmbeddedImages && opList) {
      // Collect image references from the operator list.
      const wanted = [];
      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];

        if (
          fn === pdfjsLib.OPS.paintImageXObject ||
          fn === pdfjsLib.OPS.paintImageXObjectRepeat ||
          fn === pdfjsLib.OPS.paintJpegXObject
        ) {
          const name = args?.[0];
          if (typeof name === "string") wanted.push({ type: "xobject", name });
        }

        if (fn === pdfjsLib.OPS.paintInlineImageXObject) {
          const inline = args?.[0];
          if (inline && typeof inline === "object") wanted.push({ type: "inline", inline });
        }
      }

      let imgIdx = 0;
      for (const w of wanted) {
        imgIdx += 1;
        const id = w.type === "xobject" ? w.name : `inline_${imgIdx}`;

        let decoded = null;
        if (w.type === "xobject") decoded = await getPageObj(page, w.name);
        if (w.type === "inline") decoded = w.inline;

        const pngBuffer = await decodedImageToPngBuffer(decoded);
        if (!pngBuffer) {
          embeddedSkipped += 1;
          continue;
        }

        const wPx = decoded.width ?? null;
        const hPx = decoded.height ?? null;

        const fileBase = `p${String(pageNum).padStart(3, "0")}-img${String(imgIdx).padStart(4, "0")}`;
        const rawPath = path.join(embeddedRawDir, `${fileBase}.png`);
        await fs.writeFile(rawPath, pngBuffer);
        const rawStat = await fs.stat(rawPath);

        const optimized = await encodeOptimized(pngBuffer, { maxDim, jpegQualities });
        const optPath = path.join(embeddedOptDir, `${fileBase}.${optimized.ext}`);
        await fs.writeFile(optPath, optimized.buffer);
        const optStat = await fs.stat(optPath);

        embeddedExtracted += 1;
        embeddedRows.push({
          page: pageNum,
          id,
          px: wPx && hPx ? `${wPx}x${hPx}` : "",
          rawSize: fmtBytes(rawStat.size),
          optSize: fmtBytes(optStat.size),
          saved: percentSaved(rawStat.size, optStat.size),
          rawPath,
          optPath,
        });
      }
    }
  }

  console.log(`PDF: ${pdfPath}`);
  console.log(`Output: ${runDir}`);
  console.log(
    `Pages: ${pagesToProcess}/${totalPages}  |  Rendered slides: ${pagesRendered}  |  Extract embedded images: ${extractEmbeddedImages ? "yes" : "no"}`,
  );
  console.log("");

  // Also output an optimized PDF into optimized/
  const gsPath = findExecutableOnPath("gs") ?? "gs";
  const optimizedPdfPath = path.join(optDir, `${safeNameForPath(pdfPath)}-optimized.pdf`);
  try {
    await runGhostscriptOptimizePdf({
      gsPath,
      inputPdfPath: pdfPath,
      outputPdfPath: optimizedPdfPath,
      preset: pdfPreset,
      dpi: pdfDpi,
    });
    const outStat = await fs.stat(optimizedPdfPath);
    console.log(
      `Optimized PDF: ${optimizedPdfPath}  (${fmtBytes(inputPdfStat.size)} -> ${fmtBytes(outStat.size)}, saved ${percentSaved(
        inputPdfStat.size,
        outStat.size,
      )})`,
    );
  } catch (e) {
    console.log(
      `Optimized PDF: (failed) ${String(e?.message || e)}. You can try installing Ghostscript (e.g. \`brew install ghostscript\`).`,
    );
  }
  console.log("");

  if (pageRows.length) {
    console.log("Rendered pages:");
    console.table(pageRows);
  }

  if (extractEmbeddedImages) {
    console.log("");
    if (embeddedRows.length) {
      console.log("Embedded images:");
      console.table(embeddedRows);
    } else {
      console.log("Embedded images: none extracted (or all images were in an unsupported format).");
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});


