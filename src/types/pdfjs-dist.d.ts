declare module "pdfjs-dist/build/pdf.mjs" {
  // Minimal typing shim for dynamic import usage in `PdfJsViewer.tsx`.
  // Replace with proper types if/when `@types/pdfjs-dist` becomes available.
  export type PDFLoadingTask = { promise: Promise<unknown> };
  export function getDocument(src: unknown): PDFLoadingTask;
  export const GlobalWorkerOptions: { workerSrc?: string };
  export const version: string;
  const _default: unknown;
  export default _default;
}

declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export type PDFLoadingTask = { promise: Promise<unknown> };
  export function getDocument(src: unknown): PDFLoadingTask;
  export const version: string;
  const _default: unknown;
  export default _default;
}

declare module "pdfjs-dist/webpack.mjs" {
  export type PDFLoadingTask = { promise: Promise<unknown> };
  export function getDocument(src: unknown): PDFLoadingTask;
  export const version: string;
  const _default: unknown;
  export default _default;
}




