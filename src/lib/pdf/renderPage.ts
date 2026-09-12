/**
 * Server-side PDF page rendering (pdfjs-dist + @napi-rs/canvas).
 *
 * Why this exists:
 * - The prebuilt npm `sharp` has no PDF input support (`sharp.format.pdf.input.buffer === false`),
 *   so PDF bytes must be rasterized with pdfjs before sharp can resize/encode them.
 * - Both `pdfjs-dist` and `@napi-rs/canvas` are listed in `serverExternalPackages` (next.config.ts)
 *   so Node loads them from `node_modules` at runtime instead of bundling them.
 *
 * All imports here are static-analyzable (no file-URL dynamic imports) so Next's output tracing
 * includes the packages in the serverless bundle.
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { debugLog } from "@/lib/debug";

export type PdfJsGetDocumentOptions = {
  data: Uint8Array;
  disableWorker?: boolean;
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
  wasmUrl?: string;
};

/** Minimal surface of the pdfjs page proxy that we rely on. */
export type PdfJsPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<unknown> };
  getTextContent?: () => Promise<unknown>;
};

/** Minimal surface of the pdfjs document proxy that we rely on. */
export type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  destroy?: () => Promise<unknown>;
};

export type PdfJsLib = {
  getDocument: (opts: PdfJsGetDocumentOptions) => { promise: Promise<PdfJsDocument> };
  GlobalWorkerOptions?: { workerSrc?: string };
  version?: string;
};

let _cachedPdfJsLibPromise: Promise<PdfJsLib> | null = null;
let _cachedAssetUrls: { standardFontDataUrl?: string; cMapUrl?: string; wasmUrl?: string } | null = null;

/**
 * Resolve pdfjs-dist's bundled asset directories (standard fonts, CMaps, wasm decoders).
 *
 * Best-effort: when the package root cannot be resolved (or the directories are missing),
 * we simply omit the options and pdfjs falls back to its defaults.
 */
function resolvePdfJsAssetUrls(): { standardFontDataUrl?: string; cMapUrl?: string; wasmUrl?: string } {
  if (_cachedAssetUrls) return _cachedAssetUrls;
  const out: { standardFontDataUrl?: string; cMapUrl?: string; wasmUrl?: string } = {};
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("pdfjs-dist/package.json");
    const pkgRoot = path.dirname(pkgJsonPath);
    const toDirUrl = (dir: string): string | undefined => {
      const abs = path.join(pkgRoot, dir);
      try {
        if (!fs.existsSync(abs)) return undefined;
      } catch {
        return undefined;
      }
      // pdfjs concatenates `${baseUrl}${filename}`, so the trailing slash matters.
      return `${pathToFileURL(abs).href}/`;
    };
    out.standardFontDataUrl = toDirUrl("standard_fonts");
    out.cMapUrl = toDirUrl("cmaps");
    out.wasmUrl = toDirUrl("wasm");
  } catch {
    // ignore; assets are optional
  }
  _cachedAssetUrls = out;
  return out;
}

/**
 * Lazy-load pdfjs (legacy build, Node-safe) once per process.
 *
 * On Node, pdfjs disables the web worker and runs a "fake worker" in-process, so no
 * `workerSrc` configuration is required.
 */
export async function getPdfJsLib(): Promise<PdfJsLib> {
  if (_cachedPdfJsLibPromise) return _cachedPdfJsLibPromise;
  _cachedPdfJsLibPromise = (async () => {
    const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsLib & {
      default?: PdfJsLib;
    };
    const lib = typeof mod.getDocument === "function" ? mod : (mod.default as PdfJsLib);
    if (!lib || typeof lib.getDocument !== "function") {
      throw new Error("pdfjs-dist: getDocument export not found");
    }
    debugLog(2, "[pdf][pdfjs] loaded", { version: lib.version ?? null });
    return lib;
  })();
  return _cachedPdfJsLibPromise;
}

/**
 * Open a PDF document from bytes.
 *
 * NOTE: pdfjs transfers `data.buffer` to its (fake) worker even on Node, which detaches it.
 * We always pass a copy so callers can safely reuse their original `pdfBytes`.
 */
export async function openPdfDocument(pdfBytes: Uint8Array): Promise<PdfJsDocument> {
  const pdfjsLib = await getPdfJsLib();
  const data = new Uint8Array(pdfBytes);
  const assets = resolvePdfJsAssetUrls();
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    ...(assets.standardFontDataUrl ? { standardFontDataUrl: assets.standardFontDataUrl } : {}),
    ...(assets.cMapUrl ? { cMapUrl: assets.cMapUrl, cMapPacked: true } : {}),
    ...(assets.wasmUrl ? { wasmUrl: assets.wasmUrl } : {}),
  });
  return loadingTask.promise;
}

/**
 * Render a single PDF page to a PNG buffer.
 *
 * - `pageNumber` is 1-indexed (pdfjs convention).
 * - `scale` is the base render scale (2 = ~144dpi for a 72pt page); the output is then
 *   capped at `maxWidth` pixels wide by reducing the scale (never enlarged beyond `scale`).
 * - Pass `pdfDocument` (from `openPdfDocument`) to avoid re-parsing when rendering many pages.
 */
export async function renderPdfPageToPng(params: {
  pdfBytes?: Uint8Array;
  pdfDocument?: PdfJsDocument;
  pageNumber: number;
  maxWidth?: number;
  scale?: number;
}): Promise<{ png: Buffer; width: number; height: number }> {
  const pageNumber = Math.max(1, Math.floor(params.pageNumber || 1));
  const maxWidth = Math.max(1, Math.floor(params.maxWidth ?? 1200));
  const scale = params.scale && Number.isFinite(params.scale) && params.scale > 0 ? params.scale : 2;

  /**
   * NOTE: `@napi-rs/canvas` ships native bindings per-platform. Import it lazily so the
   * calling route module still loads even if the binding is unavailable; the caller can
   * then degrade gracefully (e.g. keep a prior preview).
   */
  const { createCanvas } = await import("@napi-rs/canvas");

  if (!params.pdfDocument && !params.pdfBytes) {
    throw new Error("renderPdfPageToPng: pdfBytes or pdfDocument is required");
  }
  let ownedDocument: PdfJsDocument | null = null;
  const pdf = params.pdfDocument ?? (ownedDocument = await openPdfDocument(params.pdfBytes as Uint8Array));

  try {
    const page = await pdf.getPage(pageNumber);
    if (!page || typeof page.getViewport !== "function" || typeof page.render !== "function") {
      throw new Error("pdfjs page missing expected methods");
    }

    const baseViewport = page.getViewport({ scale });
    const finalScale = baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
    const viewport = page.getViewport({ scale: finalScale });

    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    // PDF pages are conceptually white; pdfjs only paints what the page draws.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = canvas.toBuffer("image/png");
    return { png, width, height };
  } finally {
    if (ownedDocument && typeof ownedDocument.destroy === "function") {
      try {
        await ownedDocument.destroy();
      } catch {
        // ignore
      }
    }
  }
}
