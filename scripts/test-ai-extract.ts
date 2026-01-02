#!/usr/bin/env node
/**
 * Test AI extraction against a PDF-extracted text file.
 *
 * IMPORTANT: This script calls the production `analyzePdfText()` implementation
 * in `src/lib/ai/analyzePdfText.ts`, so it always uses the same prompts/config.
 *
 * Usage:
 *   OPENAI_API_KEY=... npm run test:ai-extract -- tmp/usavx2.txt
 *   OPENAI_API_KEY=... npm run test:ai-extract -- --pdf public/sample/usavx.pdf
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

import { analyzePdfText } from "../src/lib/ai/analyzePdfText";
/**
 * Usage (uses error, trim, exit).
 */


function usage(exitCode = 1) {
  console.error(
    `
Usage:
  npm run test:ai-extract -- [txtPath]
  npm run test:ai-extract -- --pdf <pdfPath>

Notes:
  - Uses OPENAI_API_KEY (loadable via .env / .env.local by dotenv)
  - Defaults txtPath to tmp/usavx.txt
`.trim(),
  );
  process.exit(exitCode);
}
/**
 * Extract Pages From Pdf (uses readFileSync, getDocument, getPage).
 */


async function extractPagesFromPdf(pdfPath: string): Promise<Array<{ page_number: number; text: string }>> {
  const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true });
  const pdf = await loadingTask.promise;
  const numPages = (pdf as { numPages?: number }).numPages || 0;
  const pages: Array<{ page_number: number; text: string }> = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await (pdf as { getPage: (n: number) => Promise<unknown> }).getPage(i);
    const content = await (page as { getTextContent: () => Promise<unknown> }).getTextContent();
    const items = (content as { items?: unknown } | null)?.items;
    const arr = Array.isArray(items) ? (items as Array<{ str?: unknown }>) : [];
    const text = arr
      .map((it) => (it && typeof it.str === "string" ? it.str : ""))
      .filter(Boolean)
      .join(" ");
    pages.push({ page_number: i, text });
  }
  return pages;
}
/**
 * Script entry point.
 */


async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage(0);

  const pdfFlagIdx = args.indexOf("--pdf");
  const pdfPathArg = pdfFlagIdx >= 0 ? args[pdfFlagIdx + 1] : null;

  let payload: { pages?: Array<{ page_number: number; text: string }>; fullText?: string };

  if (pdfPathArg) {
    const pdfResolved = path.resolve(process.cwd(), pdfPathArg);
    if (!fs.existsSync(pdfResolved)) throw new Error(`PDF file not found: ${pdfResolved}`);
    const pages = await extractPagesFromPdf(pdfResolved);
    payload = { pages };
  } else {
    const txtPath = args[0] ?? "tmp/usavx.txt";
    const resolved = path.resolve(process.cwd(), txtPath);
    if (!fs.existsSync(resolved)) throw new Error(`Input text file not found: ${resolved}`);
    const pdfText = fs.readFileSync(resolved, "utf8");
    payload = { fullText: pdfText };
  }

  const out = await analyzePdfText(payload);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});



