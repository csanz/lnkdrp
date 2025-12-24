#!/usr/bin/env node
/**
 * Extract text from a PDF into ./tmp.
 *
 * Usage:
 *   node scripts/pdf-to-text.mjs [pdfPath] [outputTxtPath]
 *
 * Examples:
 *   node scripts/pdf-to-text.mjs public/sample/usavx.pdf
 *   node scripts/pdf-to-text.mjs public/sample/usavx.pdf ./tmp/usavx.txt
 */
import fs from "fs";
import path from "node:path";
import process from "node:process";

import pdf from "pdf-parse";

/**
 * Print usage instructions and exit the process.
 */
function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/pdf-to-text.mjs [pdfPath] [outputTxtPath]

Notes:
  - If pdfPath is omitted, defaults to public/sample/usavx.pdf
  - If outputTxtPath is omitted, writes to ./tmp/<inputBase>.txt
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Build the default output path under ./tmp for a given PDF input path.
 */
function defaultOutputPathForInput(input) {
  const base = path.basename(input);
  const name = base.replace(/\.[^/.]+$/, "") || "document";
  return path.join("tmp", `${name}.txt`);
}

/**
 * Entry point: read a PDF from disk, extract text, and write a .txt file.
 */
async function main() {
  const pdfPath = process.argv[2] ?? "public/sample/usavx.pdf";
  if (pdfPath === "--help" || pdfPath === "-h") usage(0);

  const outputPath = process.argv[3] ?? defaultOutputPathForInput(pdfPath);

  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdf(dataBuffer);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, data.text ?? "", "utf8");

  console.log(`Wrote ${outputPath} (${(data.text ?? "").length} chars)`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});



