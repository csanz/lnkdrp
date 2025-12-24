/**
 * Utilities for building Open Graph images using `next/og`.
 *
 * These helpers are designed for the Node.js runtime (ImageResponse is not
 * supported on Edge for all use cases, and we often need Node fs access).
 */

import { ImageResponse } from "next/og";

export type OgDims = { width: number; height: number };

export const DEFAULT_OG_SIZE: OgDims = { width: 1200, height: 630 };

/**
 * Determine a mime type from a pathname or URL string.
 */
export function mimeFromPath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/**
 * Parse PNG dimensions from an in-memory buffer.
 */
export function parsePngDims(buf: Buffer): OgDims | null {
  // PNG signature + IHDR chunk:
  // width/height are 4-byte big-endian at offsets 16 and 20.
  if (buf.length < 24) return null;
  const sig = buf.subarray(0, 8);
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!sig.equals(pngSig)) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return null;
  return { width, height };
}

/**
 * Parse JPEG dimensions from an in-memory buffer (baseline/progressive SOF).
 */
export function parseJpegDims(buf: Buffer): OgDims | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI

  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers (no length)
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (i + 4 >= buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;

    const isSof =
      marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3;
    if (isSof) {
      if (i + 2 + len > buf.length) break;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Best-effort dimension sniffing for PNG/JPEG images.
 */
export function sniffImageDims(buf: Buffer): OgDims | null {
  return parsePngDims(buf) ?? parseJpegDims(buf);
}

/**
 * Create an ImageResponse that renders the given image bytes as a data URI.
 */
export function imageResponseFromBytes(params: {
  bytes: Buffer;
  mime: string;
  alt: string;
  dims?: OgDims | null;
  cacheControl?: string;
}) {
  const dims = params.dims ?? sniffImageDims(params.bytes) ?? DEFAULT_OG_SIZE;
  const base64 = params.bytes.toString("base64");
  const imgSrc = `data:${params.mime};base64,${base64}`;

  const res = new ImageResponse(
    (
      // next/image can't be used inside ImageResponse (it renders server-side OG images).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imgSrc}
        width={dims.width}
        height={dims.height}
        alt={params.alt}
        style={{ objectFit: "cover" }}
      />
    ),
    { width: dims.width, height: dims.height },
  );

  if (params.cacheControl) {
    res.headers.set("Cache-Control", params.cacheControl);
  }

  return res;
}



