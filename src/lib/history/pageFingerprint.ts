/**
 * Perceptual fingerprint of a rendered page image.
 *
 * Why this exists: `slideNodes[].imageHash` is a sha256 of the (normalized) thumbnail pixels, so it
 * answers "are these bytes identical", not "does this page look the same". Every MCP upload is now
 * run through Ghostscript first (`mcp/src/optimize.ts`), which re-encodes the page images, and the
 * processing job then re-rasterizes and re-JPEGs every page anyway. Two runs of the *same* deck
 * therefore never produce the same bytes: with an exact hash every page of an unchanged re-upload
 * reports "graphics changed", which is what the owner hit — a "no changes" summary above a list of
 * all nine pages. Byte-identical re-renders are the normal case here, not an edge case, so the
 * comparison has to be perceptual.
 *
 * The fingerprint is a 256-bit difference hash (dHash): the image is reduced to a 17x16 greyscale
 * grid and each pixel is compared with its right-hand neighbour, giving 16x16 = 256 bits, stored as
 * 64 lowercase hex chars. dHash keys on local gradients (where the picture gets lighter/darker),
 * which survive resampling and JPEG quantization but change as soon as the artwork itself does.
 */

/** Grid used for the difference hash: 16 comparisons per row over 16 rows = 256 bits. */
const FP_WIDTH = 17;
const FP_HEIGHT = 16;

/** Bits in a fingerprint, and the hex length that encodes them. */
export const PAGE_FINGERPRINT_BITS = (FP_WIDTH - 1) * FP_HEIGHT;
export const PAGE_FINGERPRINT_HEX_LENGTH = PAGE_FINGERPRINT_BITS / 4;

/**
 * Largest Hamming distance (out of 256 bits) still counted as "the same page".
 *
 * Measured on the deck that produced the bug report (9 slides), running the real pipeline — page
 * rendered at 1200px, thumbnail at 480px, mozjpeg:
 *   - original PDF vs the same PDF after the MCP's Ghostscript pass: 0-7 bits
 *   - two Ghostscript outputs re-encoded at different JPEG qualities: 0-4 bits
 *   - two *different* slides of the same deck: 54-112 bits
 * Re-encoding only flips bits where two neighbouring pixels were already within a rounding error of
 * each other, which is why the noise floor is single digits. 12 bits (<5% of the hash) sits in the
 * empty middle of that gap: well above encoder noise, far below any real visual edit — a change too
 * small to move 12 bits is a change too small to see in a thumbnail. Compared with `>`, so a
 * distance of exactly 12 still counts as unchanged.
 */
export const PAGE_FINGERPRINT_MAX_DISTANCE = 12;

let sharpPromise: Promise<any> | null = null;
/** Lazily loaded sharp (native module; only needed when a fingerprint is computed). */
async function getSharp(): Promise<any> {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((mod) => (mod as any).default ?? (mod as any));
  }
  return sharpPromise;
}

/** Number of 1 bits in a byte value. */
function popcount8(byte: number): number {
  let v = byte & 0xff;
  let count = 0;
  while (v) {
    v &= v - 1;
    count += 1;
  }
  return count;
}

const HEX_RE = /^[0-9a-f]+$/;

/** A stored value usable as a fingerprint, or null. */
export function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  if (!hex || hex.length % 2 !== 0 || !HEX_RE.test(hex)) return null;
  return hex;
}

/**
 * Hamming distance between two hex fingerprints, or null when they are not comparable
 * (missing, malformed, or different lengths — e.g. a fingerprint from a future grid size).
 */
export function fingerprintDistance(a: unknown, b: unknown): number | null {
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  if (!left || !right || left.length !== right.length) return null;
  let distance = 0;
  for (let i = 0; i < left.length; i += 2) {
    const l = Number.parseInt(left.slice(i, i + 2), 16);
    const r = Number.parseInt(right.slice(i, i + 2), 16);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
    distance += popcount8(l ^ r);
  }
  return distance;
}

/**
 * Do two fingerprints describe visually different pages?
 * Returns null when they cannot be compared, so callers can fall back to the exact hash.
 */
export function fingerprintsDiffer(
  a: unknown,
  b: unknown,
  maxDistance: number = PAGE_FINGERPRINT_MAX_DISTANCE,
): boolean | null {
  const distance = fingerprintDistance(a, b);
  if (distance === null) return null;
  return distance > maxDistance;
}

/**
 * Compute the fingerprint of an encoded image (the page JPEG or its thumbnail).
 * Best-effort: returns null if the image cannot be decoded, so a failure only costs the
 * comparison its precision, never the upload.
 */
export async function computePageFingerprint(imageBytes: Buffer | Uint8Array): Promise<string | null> {
  try {
    const sharp = await getSharp();
    const { data, info } = await sharp(imageBytes)
      .grayscale()
      .resize({ width: FP_WIDTH, height: FP_HEIGHT, fit: "fill", kernel: "cubic" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = Math.max(1, Math.floor(Number(info?.channels) || 1));
    const width = Math.floor(Number(info?.width) || 0);
    const height = Math.floor(Number(info?.height) || 0);
    if (width !== FP_WIDTH || height !== FP_HEIGHT) return null;

    const bits: number[] = [];
    for (let y = 0; y < FP_HEIGHT; y++) {
      for (let x = 0; x < FP_WIDTH - 1; x++) {
        const left = data[(y * FP_WIDTH + x) * channels];
        const right = data[(y * FP_WIDTH + x + 1) * channels];
        bits.push(left > right ? 1 : 0);
      }
    }

    let hex = "";
    for (let i = 0; i < bits.length; i += 4) {
      const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
      hex += nibble.toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}
