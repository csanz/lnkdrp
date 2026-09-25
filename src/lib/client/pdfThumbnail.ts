/**
 * Client-side first-page thumbnail (PDF -> PNG blob), shared by every upload surface.
 *
 * Three copies of this used to live in the upload pipeline, the replace-link page and the request
 * page, each calling `getDocument({ data, disableWorker: true })`. pdf.js 5 has no `disableWorker`
 * option and, in a browser, refuses to load a document with no worker configured
 * ("No GlobalWorkerOptions.workerSrc specified"), so the promise rejected, the catch returned null,
 * and the thumbnail silently never rendered (code review 2026-09-23, M25).
 *
 * The worker is wired the way `PdfJsViewer` wires it: the vendored ESM bundle under `/public/pdfjs`
 * and one module worker shared through `globalThis.__lnkdrpPdfJsWorkerPort`, so a page that has
 * the viewer open reuses its worker rather than starting a second one. `workerSrc` is set as well,
 * so a browser without module workers still has a script for pdf.js's fallback to load.
 */

const PDFJS_MODULE_URL = "/pdfjs/pdf.min.mjs";
const PDFJS_WORKER_URL = "/pdfjs/pdf.worker.min.mjs";

type PdfJsModule = {
  GlobalWorkerOptions?: { workerSrc?: string; workerPort?: unknown };
  getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfDocument> };
};

type PdfDocument = {
  getPage: (n: number) => Promise<PdfPage>;
  destroy?: () => Promise<void> | void;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<unknown> };
};

/**
 * Evaluate the pdf.js bundle with `globalThis.process` hidden.
 *
 * pdf.js decides it is in Node when `process + "" === "[object process]"`. Next injects a `process`
 * polyfill in the browser that can trip that check and send pdf.js down a Node-only path. The
 * viewer does the same dance at load time; the thumbnail loader has to as well, because whichever
 * of the two imports the module first is the one that evaluates it.
 */
async function withBrowserPdfJsEnv<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof window === "undefined") return fn();
  const g = globalThis as { process?: unknown };
  const p = g.process;
  if (!p || typeof p !== "object") return fn();
  const desc = Object.getOwnPropertyDescriptor(g, "process");
  const safe: Record<string | symbol, unknown> = {
    env: (p as { env?: unknown }).env,
    versions: (p as { versions?: unknown }).versions,
    toString: () => "[object Object]",
    [Symbol.toStringTag]: "Object",
    [Symbol.toPrimitive]: () => "[object Object]",
  };
  let replaced = false;
  try {
    Object.defineProperty(g, "process", { value: safe, configurable: true, writable: true });
    replaced = true;
  } catch {
    // Not writable: proceed and hope the heuristic is not tripped.
  }
  try {
    return await fn();
  } finally {
    if (replaced) {
      try {
        if (desc) Object.defineProperty(g, "process", desc);
        else delete g.process;
      } catch {
        // ignore
      }
    }
  }
}

/** Load the vendored pdf.js bundle with a worker configured; the module and the worker are shared. */
export async function loadPdfJs(): Promise<PdfJsModule> {
  const pdfjs = (await withBrowserPdfJsEnv(
    () => import(/* webpackIgnore: true */ PDFJS_MODULE_URL) as Promise<PdfJsModule>,
  )) as PdfJsModule;
  if (pdfjs.GlobalWorkerOptions) {
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    if (typeof window !== "undefined" && "Worker" in window && !pdfjs.GlobalWorkerOptions.workerPort) {
      try {
        const g = globalThis as { __lnkdrpPdfJsWorkerPort?: Worker };
        if (!g.__lnkdrpPdfJsWorkerPort) g.__lnkdrpPdfJsWorkerPort = new Worker(PDFJS_WORKER_URL, { type: "module" });
        pdfjs.GlobalWorkerOptions.workerPort = g.__lnkdrpPdfJsWorkerPort;
      } catch {
        // No module worker: pdf.js falls back to loading workerSrc itself.
      }
    }
  }
  return pdfjs;
}

/** True when a picked file is a PDF by type, or by extension when the type is empty. */
function looksLikePdf(file: File): boolean {
  const t = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (t && t !== "application/pdf") return false;
  if (name && !name.endsWith(".pdf")) return false;
  return t === "application/pdf" || name.endsWith(".pdf");
}

/**
 * Render the first page of a PDF to a PNG blob for an immediate preview, before the server has
 * processed the upload. Returns null for non-PDF input or when rendering fails; never throws.
 */
export async function renderPdfFirstPagePngBestEffort(file: File): Promise<Blob | null> {
  try {
    if (!looksLikePdf(file)) return null;
    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: pdfBytes }).promise;
    try {
      const page = await pdf.getPage(1);

      const scale = 2;
      const maxWidth = 1200;
      const baseViewport = page.getViewport({ scale });
      const finalScale = baseViewport.width > maxWidth ? scale * (maxWidth / baseViewport.width) : scale;
      const viewport = page.getViewport({ scale: finalScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      await page.render({ canvasContext: ctx, viewport }).promise;
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/png");
      });
    } finally {
      try {
        await pdf.destroy?.();
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
}
