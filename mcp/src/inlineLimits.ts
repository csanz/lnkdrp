/**
 * Ceilings for a PDF that arrives inline (`fileBase64` or `filePath`), as opposed to by URL.
 *
 * The app's single document ceiling is 50 MB (`src/lib/limits/uploads.ts`), and until now the
 * inline path quoted it too. But an inline PDF is held in this process, base64-decoded, optimized
 * with Ghostscript and parsed by pdfjs, and then sent as a JSON body to `import-bytes`, which on
 * the hosted app crosses a serverless function whose body cap is 4.5 MB. So the 50 MB promise was
 * false twice over: one write key could put 66 MB of base64 into this process's heap per call
 * (code review 2026-09-23, M16), and anything over roughly 3 MB after optimization failed on the
 * platform's own 413 rather than on anything lnkdrp wrote.
 *
 * Two numbers, then. **In**: the most an inline input may be before optimization, sized so a
 * large image-heavy deck can still be shrunk under the send ceiling. **Out**: the most that is
 * sent after optimization when the API is a hosted deployment, so the refusal is ours, says why,
 * and points at `sourceUrl`, which never crosses a function body. Against a localhost API there is
 * no platform cap, so the send ceiling is the input ceiling.
 */
import { isLocalApiUrl } from "./localApi";

/** Decoded size an inline PDF may have before optimization. */
export const INLINE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
export const INLINE_UPLOAD_MAX_LABEL = "16 MB";

/**
 * `INLINE_UPLOAD_MAX_BYTES` as base64 text length, so an oversized string is refused from its
 * length alone, before a byte is decoded. Base64 emits 4 characters per 3 bytes plus padding.
 */
export const INLINE_UPLOAD_MAX_BASE64_CHARS = Math.ceil(INLINE_UPLOAD_MAX_BYTES / 3) * 4 + 4;

/**
 * The Zod bound on the argument: looser than the real ceiling on purpose, so a value near it
 * reaches the tool's own check and its `too_large` message instead of a raw protocol error.
 */
export const INLINE_BASE64_SCHEMA_MAX_CHARS = INLINE_UPLOAD_MAX_BASE64_CHARS * 3;

/**
 * Decoded size the inline path may send to a hosted API after optimization: 3 MB of PDF is 4 MB
 * of base64, which with the JSON envelope clears the 4.5 MB function body cap.
 */
export const INLINE_SEND_MAX_BYTES = 3 * 1024 * 1024;
export const INLINE_SEND_MAX_LABEL = "3 MB";

/** Decoded bytes a base64 string of `chars` characters carries, ignoring line breaks. */
export function decodedBytesFromBase64Length(chars: number, padding: number = 0): number {
  return Math.floor((chars * 3) / 4) - Math.min(2, Math.max(0, padding));
}

/** The send ceiling for `apiUrl`: the platform's on a hosted API, the input ceiling on localhost. */
export function inlineSendMaxBytes(apiUrl: string): number {
  return isLocalApiUrl(apiUrl) ? INLINE_UPLOAD_MAX_BYTES : INLINE_SEND_MAX_BYTES;
}

/** Human label for {@link inlineSendMaxBytes}. */
export function inlineSendMaxLabel(apiUrl: string): string {
  return isLocalApiUrl(apiUrl) ? INLINE_UPLOAD_MAX_LABEL : INLINE_SEND_MAX_LABEL;
}
