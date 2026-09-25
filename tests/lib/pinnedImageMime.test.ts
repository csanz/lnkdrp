/** Image type from bytes, never from the upstream header (review Low, public share). */
import { describe, expect, it } from "vitest";

import { MAX_PREVIEW_BYTES, pinnedImageMime } from "../../src/lib/share/pinnedImageMime";

describe("pinnedImageMime", () => {
  it("recognises PNG and JPEG by their magic bytes", () => {
    expect(pinnedImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("image/png");
    expect(pinnedImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
  });

  it("refuses markup, SVG, GIF and empty bodies", () => {
    expect(pinnedImageMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(pinnedImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(pinnedImageMime(Buffer.from("GIF89a"))).toBeNull();
    expect(pinnedImageMime(Buffer.alloc(0))).toBeNull();
  });

  it("does not read past a short buffer", () => {
    expect(pinnedImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(pinnedImageMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("exports the shared byte cap", () => {
    expect(MAX_PREVIEW_BYTES).toBe(8 * 1024 * 1024);
  });
});
