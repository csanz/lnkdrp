/**
 * Minimal smoke test for Vercel Blob server-side uploads.
 *
 * Uploads a couple of local sample files under `public/sample/` to Blob using the
 * `BLOB_READ_WRITE_TOKEN` and then verifies the upload via a `head()` call.
 *
 * Usage:
 *   BLOB_READ_WRITE_TOKEN=... node scripts/test-vercel-blob.mjs
 *
 * Note:
 * - This script auto-loads `.env.local`.
 */

import path from "node:path";
import fs from "node:fs/promises";
import dotenv from "dotenv";
import { put, head } from "@vercel/blob";
import { safeTimestamp } from "./lib/time.mjs";

dotenv.config({ path: '.env.local' });

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error(
    [
      'Missing BLOB_READ_WRITE_TOKEN.',
      'Add it to .env.local (this script loads .env.local automatically).',
      '',
      'Example:',
      'BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...',
    ].join('\n'),
  );
  process.exit(1);
}

const sampleUploads = [
  {
    localPath: 'public/sample/skycatch.jpg',
    contentType: 'image/jpeg',
  },
  {
    localPath: 'public/sample/usavx.pdf',
    contentType: 'application/pdf',
  },
];

/**
 * Upload a small set of sample files to Vercel Blob and print results.
 */
async function main() {
  const prefix = `tests/${safeTimestamp()}`;

  console.log(`Uploading samples to Vercel Blob under prefix: ${prefix}`);

  const results = [];
  for (const item of sampleUploads) {
    const abs = path.resolve(process.cwd(), item.localPath);
    const data = await fs.readFile(abs);
    const filename = path.basename(item.localPath);
    const blobPathname = `${prefix}/${filename}`;

    const blob = await put(blobPathname, data, {
      access: 'public',
      contentType: item.contentType,
    });

    results.push({ item, blob });
  }

  console.log('\nUpload results:');
  for (const { item, blob } of results) {
    console.log(`- ${item.localPath} -> ${blob.pathname}`);
    console.log(`  url: ${blob.url}`);

    // quick verification: fetch metadata back from Blob
    const meta = await head(blob.url);
    console.log(`  head: size=${meta.size} contentType=${meta.contentType}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});




