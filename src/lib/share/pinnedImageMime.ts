/**
 * The content type of an image this origin serves, decided by the bytes, never echoed upstream.
 *
 * The PDF proxy learned this the hard way: with the type copied from the store and no `script-src`
 * in the app's CSP, an upstream that answered `text/html` made this origin serve markup. The
 * pipeline writes PNG; JPEG is tolerated for older rows. Anything else is not an image we are
 * willing to serve from our own origin, so the caller answers 404.
 *
 * Shared by the document preview, the room thumbnail and the version page images, which used to
 * carry two copies of this sniffer and one route that echoed the upstream header.
 */

/** Largest image any of the preview routes will buffer and serve. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `image/png` or `image/jpeg` from the leading bytes, or null for anything else. */
export function pinnedImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}
