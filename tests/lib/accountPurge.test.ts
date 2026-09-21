/**
 * The file collector behind the account purge.
 *
 * Tested because the purge is destructive, had no tests at all, and had never run anywhere: the
 * first time it executes will be against a real person's account, and the failure it shipped with
 * was silent by construction — the rows naming the missed files were deleted in the same breath,
 * so nothing afterwards could have found them to notice.
 */
import { describe, expect, test } from "vitest";

import { UPLOAD_BLOB_SELECT, blobUrlsOf } from "@/lib/accounts/purge";

const B = "https://store.public.blob.vercel-storage.com";

describe("blobUrlsOf", () => {
  test("collects the per-page slide images, which are most of the bytes", () => {
    // A processed PDF stores an image and a thumbnail per page. On the development database that
    // is 1,306 slide entries against 397 uploads — the majority of everything stored.
    const upload = {
      blobUrl: `${B}/doc.pdf`,
      slideNodes: [
        { pageNumber: 1, imageUrl: `${B}/p1.jpg`, thumbUrl: `${B}/p1-thumb.jpg` },
        { pageNumber: 2, imageUrl: `${B}/p2.jpg`, thumbUrl: `${B}/p2-thumb.jpg` },
      ],
    };
    const urls = blobUrlsOf(upload);
    expect(urls).toContain(`${B}/p1.jpg`);
    expect(urls).toContain(`${B}/p2-thumb.jpg`);
    expect(urls).toHaveLength(5);
  });

  test("keeps the two fields the schema does not declare", () => {
    // `previewImageUrl` and `firstPagePngUrl` are written by the processor and are on 333 rows
    // here, schema or no schema. A field being undeclared does not make its file imaginary.
    const urls = blobUrlsOf({ previewImageUrl: `${B}/preview.jpg`, firstPagePngUrl: `${B}/first.png` });
    expect(urls).toEqual([`${B}/preview.jpg`, `${B}/first.png`]);
  });

  test("ignores anything that is not a URL, without throwing", () => {
    // Lean Mongo documents hold whatever the database holds.
    expect(blobUrlsOf({ blobUrl: null, slideNodes: null })).toEqual([]);
    expect(blobUrlsOf({ blobUrl: 42, slideNodes: "nope" })).toEqual([]);
    expect(blobUrlsOf({ slideNodes: [null, 7, { imageUrl: "/relative.jpg" }, { thumbUrl: `${B}/ok.jpg` }] })).toEqual([`${B}/ok.jpg`]);
    expect(blobUrlsOf({})).toEqual([]);
  });

  test("the projection covers every key the collector reads", () => {
    // The bug in one sentence: a query that does not select `slideNodes` hands this function an
    // object with no slides in it, and it correctly reports no slides. Keeping the projection and
    // the reader together is what stops that happening again.
    const projected = Object.keys(UPLOAD_BLOB_SELECT);
    for (const key of ["blobUrl", "previewImageUrl", "firstPagePngUrl", "extractedTextBlobUrl", "slideNodes"]) {
      expect(projected).toContain(key);
    }
  });
});
