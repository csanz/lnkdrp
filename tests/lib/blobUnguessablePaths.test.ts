/**
 * Every artifact the upload pipeline writes gets an unguessable path.
 *
 * The store has one access mode — `access: "public"` is a one-member literal type in
 * `@vercel/blob` — so the path *is* the access control. With `addRandomSuffix: false` every
 * artifact sat at a pure function of two ObjectIds:
 *
 *     docs/<docId>/uploads/<uploadId>/preview.png
 *     docs/<docId>/uploads/<uploadId>/extracted.txt          the full text of the PDF
 *     docs/<docId>/uploads/<uploadId>/pages/p0001/image.jpg
 *
 * A recipient was handed the preview URL, which spells out both ids, and the page count is on the
 * page. So one URL yielded every page image and the complete extracted text — and kept yielding
 * them after the link was revoked, expired, password-protected or archived, because nothing about
 * the link is consulted when a CDN serves a public blob.
 *
 * This is B0 from `docs/prds/lnkdrp-blob-privacy.md`. It does not make the bytes private; a URL
 * somebody saved still works. It severs "saw one thing" from "has everything", which is the actual
 * complaint, and it is a grep away from being undone by a well-meaning "make retries idempotent"
 * change — hence a test that reads the source.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseDocUploadBlobPathname } from "@/lib/blob/serverClientUploadRoute";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file that writes a document artifact to the store. */
const WRITERS = [
  "src/app/api/uploads/[uploadId]/process/route.ts",
  "src/app/api/uploads/[uploadId]/import-bytes/route.ts",
  "src/app/api/uploads/[uploadId]/import-url/route.ts",
  // The browser's own uploads, where the default is `false` and the preview URL — the one a
  // recipient is actually handed — is minted.
  "src/app/api/blob/upload/route.ts",
];

describe("no artifact is written to a derivable path", () => {
  test.each(WRITERS)("%s never asks for a deterministic path", (path) => {
    expect(read(path)).not.toContain("addRandomSuffix: false");
  });

  test.each(WRITERS)("%s asks for a random one", (path) => {
    expect(read(path)).toContain("addRandomSuffix: true");
  });

  test("the whole source tree is clear of it", () => {
    // Cheap belt-and-braces: a new writer added elsewhere is caught without editing WRITERS.
    const out = execSync('grep -rl "addRandomSuffix: false" src || true', { cwd: ROOT, encoding: "utf8" });
    expect(out.split("\n").filter(Boolean)).toEqual([]);
  });
});

describe("the ids still parse out of a suffixed path", () => {
  const docId = "6ab1aa1b1a0220c0fdc7cd53";
  const uploadId = "6ab1aa1b55068178c03c61cf";

  test("a suffix on the filename does not move the ids", () => {
    // The suffix lands on the last segment; the ids are directory segments, which is why
    // authorization and ownership checks are unaffected by this change.
    for (const tail of [
      "preview.png",
      "preview-Xy7bQ2.png",
      "extracted-9fA3.txt",
      "pages/p0001/image-Kd82nQ.jpg",
      "1758499200000-deck-aB12cD.pdf",
    ]) {
      expect(parseDocUploadBlobPathname(`docs/${docId}/uploads/${uploadId}/${tail}`), tail).toEqual({
        docId,
        uploadId,
      });
    }
  });

  test("it still refuses what it always refused", () => {
    for (const bad of [
      `docs/${docId}/uploads/${uploadId}`,
      `docs/${docId}/uploads/${uploadId}/`,
      `docs/${docId}/notuploads/${uploadId}/preview.png`,
      `docs/notanid/uploads/${uploadId}/preview.png`,
      `docs/${docId}/uploads/${uploadId}/../../../etc/passwd`,
      "org-avatars/x/y.png",
    ]) {
      expect(parseDocUploadBlobPathname(bad), bad).toBe(null);
    }
  });
});
