declare module "pdf-parse" {
  type PdfParseResult = {
    text?: string;
    numpages?: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  };
/**
   * Pdf Parse.
   */


  // The library accepts Buffer, Uint8Array, and ArrayBuffer-ish inputs in practice.
  // We keep the types permissive to avoid blocking builds.
  export default function pdfParse(
    data: unknown,
    options?: unknown,
  ): Promise<PdfParseResult>;
}






