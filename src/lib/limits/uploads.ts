/**
 * The one place upload size limits are defined.
 *
 * Before this module the ceiling was written down four times and disagreed with itself: the MCP
 * tools said 3MB, `import-bytes` said 3MB, `import-url` said 25MB and the browser's direct-to-Blob
 * route said 250MB. A caller could be told "max 3MB" by one message and "max 25MB" by the next for
 * the same file. Everything that guards a PDF's size now reads a constant from here, so the number
 * moves in one edit and every message that quotes it stays true.
 *
 * Deployment caveat, and it is a real one: `UPLOAD_MAX_BYTES` is the limit this application
 * enforces, not a promise the platform underneath will carry that many bytes. The **inline base64
 * path** (`POST /api/uploads/:id/import-bytes`, and the MCP's `fileBase64` / `filePath` inputs,
 * which end there) sends the file as a JSON request body, and a serverless host caps request
 * bodies well below 50MB — Vercel Functions cap them at 4.5MB regardless of content type, and
 * base64 costs ~4/3 of the decoded size before the JSON envelope is counted. On such a deployment
 * an inline upload of a large file fails with the platform's own error (a 413, often before the
 * request ever reaches the route) rather than with anything written here. That is why the MCP
 * shrinks a PDF before sending it, and why the fallback advice is always the same:
 *
 *   - the **URL path** (`import-url`) has no such ceiling — the server fetches the bytes itself,
 *     as a response body, and streams them to Blob;
 *   - the **browser's direct upload** (`serverClientUploadRoute`) goes straight to Vercel Blob and
 *     never passes through a function body at all.
 *
 * Both of those really do handle files up to their stated limits in production.
 */

/**
 * The maximum size of a PDF this app will accept, for both the URL import and the inline base64
 * path. One number on purpose: two different ceilings for "the same file, arriving two ways" is
 * what produced the contradictory error messages this module replaced.
 */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/**
 * `UPLOAD_MAX_BYTES` as base64 text length, so an oversized payload can be rejected from the
 * string's length alone, before anything is decoded or sent. Base64 emits 4 characters per 3 bytes,
 * plus padding; the `+ 4` absorbs the final partial group.
 */
export const UPLOAD_MAX_BASE64_CHARS = Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 4;

/**
 * The Zod bound on an inline base64 tool argument — deliberately looser than
 * `UPLOAD_MAX_BASE64_CHARS`, and only a backstop against a wildly oversized string, not the real
 * size gate.
 *
 * A schema violation surfaces as a raw MCP protocol error ("-32602: Input validation error"), not
 * a `ToolError`, so a value near the real ceiling — the case a caller actually hits — must reach
 * the tool's own check and get the friendly `too_large` message instead of tripping this first.
 * Measured live: setting this equal to the real ceiling made every over-the-limit call fail with
 * the terse protocol error instead.
 */
export const UPLOAD_BASE64_SCHEMA_MAX_CHARS = UPLOAD_MAX_BASE64_CHARS * 3;

/**
 * The browser's direct-to-Blob upload ceiling (`serverClientUploadRoute`). Much larger than
 * `UPLOAD_MAX_BYTES` because those bytes never travel through a serverless function body: the
 * browser uploads straight to Vercel Blob with a scoped client token.
 */
export const BROWSER_DIRECT_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

/**
 * A size in bytes as whole megabytes, for user-facing copy ("max 50MB"). Rounds down so the number
 * shown is never larger than the limit actually enforced.
 */
export function formatMaxBytesMb(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

/** `UPLOAD_MAX_BYTES` written the way messages and tool descriptions quote it, e.g. "50MB". */
export const UPLOAD_MAX_LABEL = formatMaxBytesMb(UPLOAD_MAX_BYTES);
