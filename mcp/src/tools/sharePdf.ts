/**
 * `lnkdrp_share_pdf` — import a PDF from a URL and return its share link.
 *
 * Flow (all through the REST API with the caller's key):
 *   POST /api/docs → POST /api/uploads → POST import-url → POST process
 *   → PATCH doc { shareAllowPdfDownload } when allowDownload → POST share-password when password
 *   → optionally wait for status ready|failed (realtime channel + 2s polling, see realtime.ts)
 *   → GET /api/uploads/:id + GET /api/credits/snapshot for `warnings` / `creditsRemaining` (best-effort).
 *
 * `summary` + `keyPoints` (both or neither) go to POST /api/uploads: the server stores the agent's
 * summary, skips the automatic AI summary and charges 0 credits for it.
 *
 * Idempotent by `idempotencyKey` (per workspace, 24h, in memory): a retry returns the same doc.
 * If the import fails the empty draft doc is deleted again so a failed call leaves nothing behind;
 * failures after the file is stored keep the doc and report its ids in `details`.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  UPLOAD_BASE64_SCHEMA_MAX_CHARS,
  UPLOAD_MAX_BASE64_CHARS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
} from "../../../src/lib/limits/uploads";
import type { PlanWarning } from "../api";
import type { ToolContext } from "../context";
import { handleTool, isToolError, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { looksLikePdf, optimizePdf, type OptimizeReport } from "../optimize";
import { waitForDocStatus } from "../realtime";
import { readAiOutcome } from "./aiWarnings";
import { SAFETY_TAIL } from "./shared";

const PROCESS_NOT_READY_RETRIES = 5;
const PROCESS_NOT_READY_DELAY_MS = 1000;

/**
 * Why a local absolute path is refused when the server is not local, and what to do instead.
 *
 * `filePath` is read by the MCP **server** process. When that process runs on the caller's own
 * machine (the usual stdio / localhost setup) "the file at this path" means the same file to both
 * sides. When it runs somewhere else — a hosted mcp.lnkdrp.com — the same string either names
 * nothing, or, worse, names a file belonging to that host. Neither is what the caller meant, so
 * the input is refused outright rather than guessed at.
 */
export const LOCAL_FILE_REFUSED_MESSAGE =
  "filePath is read from disk by the MCP server itself, and this server is not running on your machine " +
  "(its lnkdrp API URL is not localhost). A path from your computer would mean nothing here, so it is refused " +
  "rather than read. Use sourceUrl with an https link to the PDF, or fileBase64 for a small file. " +
  "If the server really is local, set LNKDRP_ALLOW_LOCAL_FILES=1 in its environment.";

/** True for an API URL that points at this same machine, which is how a local MCP server is spotted. */
export function isLocalApiUrl(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  return /^127\./.test(host);
}

/**
 * Whether `filePath` may be used at all.
 *
 * Allowed when the configured lnkdrp API is on this machine (so the server is local too), or when
 * the operator has said so explicitly with `LNKDRP_ALLOW_LOCAL_FILES=1` — the escape hatch for a
 * local server pointed at a remote API, which is a real dev setup and cannot be detected any other
 * way.
 */
export function isLocalFileAccessAllowed(input: { apiUrl: string; env?: NodeJS.ProcessEnv }): boolean {
  const env = input.env ?? process.env;
  const flag = (env.LNKDRP_ALLOW_LOCAL_FILES || "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return isLocalApiUrl(input.apiUrl);
}

/** Where the PDF's bytes are coming from, once the inputs have been checked against each other. */
export type PdfSource =
  | { kind: "url"; url: string }
  | { kind: "bytes"; base64: string; fileName: string }
  | { kind: "file"; filePath: string; fileName: string };

/** The two sources whose bytes this process holds, and therefore can optimize before sending. */
export type InlinePdfSource = Extract<PdfSource, { kind: "bytes" } | { kind: "file" }>;

/**
 * Exactly one of `sourceUrl` / `fileBase64` / `filePath` must be given. Validates and normalizes
 * whichever one is present; throws `ToolError("validation", ...)` otherwise, before any upload row
 * is created. Pure: `filePath` is checked for shape and permission here, but not touched on disk
 * until `readLocalPdf`.
 */
export function resolvePdfSource(
  args: {
    sourceUrl?: string | undefined;
    fileBase64?: string | undefined;
    filePath?: string | undefined;
    fileName?: string | undefined;
  },
  apiUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): PdfSource {
  const hasUrl = typeof args.sourceUrl === "string" && args.sourceUrl.length > 0;
  const hasBytes = typeof args.fileBase64 === "string" && args.fileBase64.length > 0;
  const hasFile = typeof args.filePath === "string" && args.filePath.trim().length > 0;
  if ([hasUrl, hasBytes, hasFile].filter(Boolean).length !== 1) {
    throw new ToolError("validation", "Pass exactly one of sourceUrl, fileBase64 or filePath.");
  }

  if (hasUrl) return { kind: "url", url: validateSourceUrl(args.sourceUrl as string, apiUrl) };

  if (hasFile) {
    if (!isLocalFileAccessAllowed({ apiUrl, env })) throw new ToolError("validation", LOCAL_FILE_REFUSED_MESSAGE);
    const filePath = (args.filePath as string).trim();
    if (!path.isAbsolute(filePath)) {
      throw new ToolError(
        "validation",
        "filePath must be an absolute path (it is resolved by the MCP server, which has its own working directory). " +
          "Expand ~ yourself: /Users/you/Downloads/deck.pdf, not ~/Downloads/deck.pdf.",
      );
    }
    const fileName = (args.fileName ?? "").trim() || path.basename(filePath) || "document.pdf";
    return { kind: "file", filePath, fileName };
  }

  const base64 = (args.fileBase64 as string).trim();
  if (base64.length > UPLOAD_MAX_BASE64_CHARS) {
    throw new ToolError(
      "too_large",
      `fileBase64 decodes to more than ${UPLOAD_MAX_LABEL}. Use sourceUrl for a file this size.`,
    );
  }
  return { kind: "bytes", base64, fileName: (args.fileName ?? "").trim() || "document.pdf" };
}

/**
 * Read and vet a local PDF: it must be a regular file this process can read, non-empty, no larger
 * than `UPLOAD_MAX_BYTES`, and a PDF by its `%PDF-` byte signature — the name is never trusted.
 */
export async function readLocalPdf(filePath: string): Promise<Buffer> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new ToolError("source_not_found", `The MCP server found no file at ${filePath}.`);
  }
  if (!stat.isFile()) {
    throw new ToolError("validation", `${filePath} is not a regular file (a directory, device or socket cannot be uploaded).`);
  }
  if (stat.size <= 0) throw new ToolError("validation", `${filePath} is empty.`);
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new ToolError(
      "too_large",
      `${filePath} is ${Math.round(stat.size / (1024 * 1024))}MB, over the ${UPLOAD_MAX_LABEL} limit. Use sourceUrl for a file this size.`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new ToolError("validation", `The MCP server could not read ${filePath}: ${err instanceof Error ? err.message : "unknown error"}.`);
  }
  if (!looksLikePdf(bytes)) {
    throw new ToolError("unsupported_content_type", `${filePath} is not a PDF (its bytes do not start with "%PDF-"). lnkdrp shares PDFs only.`);
  }
  return bytes;
}

/** Bytes ready to POST to `import-bytes`, plus what optimization did on the way. */
export type InlineUpload = {
  base64: string;
  fileName: string;
  /** Set when a smaller file is being sent; `null` when the original is. */
  optimized: OptimizeReport | null;
  /** Always set when `optimized` is null: why the original is going as-is. */
  optimizeNote: string | null;
};

/**
 * Turn a local file or an inline base64 string into the payload actually sent, shrinking it first
 * when that is safe (see `../optimize`). Optimization never fails the call: on any problem the
 * original bytes go and `optimizeNote` says why.
 */
export async function prepareInlineUpload(source: InlinePdfSource, opts: { optimize: boolean }): Promise<InlineUpload> {
  let bytes: Buffer;
  if (source.kind === "file") {
    bytes = await readLocalPdf(source.filePath);
  } else {
    bytes = Buffer.from(source.base64, "base64");
    if (!looksLikePdf(bytes)) {
      throw new ToolError("unsupported_content_type", 'fileBase64 did not decode to a PDF (the bytes do not start with "%PDF-").');
    }
  }

  const outcome = await optimizePdf(bytes, { requested: opts.optimize });
  if (outcome.bytes.byteLength > UPLOAD_MAX_BYTES) {
    throw new ToolError("too_large", `The PDF is larger than ${UPLOAD_MAX_LABEL}. Use sourceUrl for a file this size.`);
  }
  // Nothing changed and the caller already handed us the encoded form: send exactly that.
  const base64 = outcome.optimized === null && source.kind === "bytes" ? source.base64 : outcome.bytes.toString("base64");
  return { base64, fileName: source.fileName, optimized: outcome.optimized, optimizeNote: outcome.note };
}

export const sharePdfInputShape = {
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .describe("Caller-chosen key (1-128 chars). Reusing it within 24h returns the same document instead of creating another."),
  title: z.string().max(200).optional().describe("Document title shown on the share page (default: Untitled document)."),
  sourceUrl: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      `Public https URL of the PDF, up to ${UPLOAD_MAX_LABEL}. Google Drive links to a PDF file work when shared with anyone who has the link, as do ` +
        "lnkdrp /s/ links. A Google Docs/Sheets/Slides editor link or a OneDrive/SharePoint link is refused: those serve a " +
        "web page, not a file - download the PDF and pass it as filePath instead. " +
        "Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  fileBase64: z
    .string()
    .min(1)
    .max(UPLOAD_BASE64_SCHEMA_MAX_CHARS)
    .optional()
    .describe(
      `The PDF's bytes, base64-encoded, for a file with no public URL (locally generated, a private attachment). ` +
        `Decoded size up to ${UPLOAD_MAX_LABEL}. Prefer filePath when the file is already on this machine: emitting a ` +
        "multi-megabyte base64 string as a tool argument is slow and easy to garble. " +
        "Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  filePath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Absolute path to a PDF, read from disk BY THE MCP SERVER - so this only works when the server runs on the same " +
        "machine as the file (a local stdio/localhost server; otherwise the call is refused with a validation error " +
        "telling you to use sourceUrl). Expand ~ yourself: /Users/you/Downloads/deck.pdf. This is the right way to " +
        `share a file the human has locally: no base64 to emit, and up to ${UPLOAD_MAX_LABEL}. ` +
        "Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  optimize: z
    .boolean()
    .default(true)
    .describe(
      "Shrink the PDF before uploading by downsampling its images (default true; needs Ghostscript on the MCP server). " +
        "Skipped for files already under 1MB. The original is kept whenever the result is not smaller, not a valid PDF, " +
        "or has a different page count, so this can never drop a page. The result's `optimized` field says what happened.",
    ),
  fileName: z
    .string()
    .max(200)
    .optional()
    .describe("File name to record, used with fileBase64 or to override filePath's own basename (default: document.pdf)."),
  allowDownload: z.boolean().default(false).describe("Let viewers download the PDF (default false)."),
  password: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Protect the share link with a password (1-128 chars). " +
        "Use exactly the password the human gave you, whatever its length - a one-character password is allowed. Never substitute a longer one of your own: they will type theirs at the gate and be locked out. Tell them the password you set; the owner can also reveal it later in the link's settings.",
    ),
  waitForReady: z.boolean().default(true).describe("Wait until processing finishes (status ready or failed) before returning."),
  timeoutSeconds: z.number().int().min(5).max(120).default(60).describe("Max seconds to wait for processing (5-120, default 60)."),
  summary: z
    .string()
    .min(40)
    .max(600)
    .optional()
    .describe(
      "Your own summary of the document, written from its content (40-600 characters, plain text; URLs and markup are stripped). " +
        "Pass together with keyPoints: the automatic AI summary is then skipped and costs 0 credits.",
    ),
  keyPoints: z
    .array(z.string().min(1).max(160))
    .min(2)
    .max(7)
    .optional()
    .describe("2-7 key points from the document, each at most 160 characters, plain text. Pass together with summary."),
};

export type SharePdfResult = {
  docId: string;
  shareId: string | null;
  shareUrl: string | null;
  replaceUrl: null;
  status: string;
  version: number;
  uploadId: string;
  title: string;
  planWarning?: PlanWarning;
  /** Present when `waitForReady` gave up before a terminal status; poll `lnkdrp_get_share`. */
  timedOut?: true;
  /**
   * How much the PDF shrank before upload, on the `fileBase64` / `filePath` paths only. `null`
   * means the original bytes were sent, and `optimizeNote` says why. Absent for `sourceUrl`, where
   * the server fetches the file itself and this process never holds it.
   */
  optimized?: OptimizeReport | null;
  /** Why the original was sent unchanged (no Ghostscript, already small, `optimize: false`, …). */
  optimizeNote?: string;
  /** Skipped or failed AI steps (the link is still valid), e.g. "AI summary skipped: out of AI credits (needs 1). …". */
  warnings: string[];
  /** Workspace credits left after processing, when the snapshot was readable. */
  creditsRemaining?: number;
};

/** Validate the source URL: https anywhere, http only for the lnkdrp app itself (dev). */
/**
 * Sources that can never resolve to a PDF, and what the caller should do instead.
 *
 * These fail today with an unhelpful error from deep in the import: a Google Slides link comes back
 * as an HTML sign-in page and is rejected as "not a PDF", which reads like a broken file rather than
 * the wrong kind of link. Hit live on 2026-09-16 with a `/presentation/d/…/edit` URL.
 *
 * Deliberately narrow. `drive.google.com` file links are NOT rejected: the app has a real Drive
 * download flow, interstitial confirm token and all, and they work whenever the file is shared with
 * anyone who has the link. Only the two shapes with no path to a PDF are turned away, and a
 * `/export` URL on a Docs host is left alone because that one does return a real file.
 */
function unsupportedSourceUrlReason(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  const isGoogleDocsHost = host === "docs.google.com" || host.endsWith(".docs.google.com");
  if (isGoogleDocsHost && /^\/(document|spreadsheets|presentation|forms)\/d\//.test(path) && !path.includes("/export")) {
    return (
      "That is a Google Docs, Sheets or Slides editor link. It serves a web page, not a PDF, and a private one serves a " +
      `sign-in page. Open it and choose File > Download > PDF Document, then pass the downloaded file as filePath (its ` +
      `absolute path, read by a local MCP server) or fileBase64 - up to ${UPLOAD_MAX_LABEL} either way. A Google Drive ` +
      "link to a PDF file does work, as long as it is shared with anyone who has the link."
    );
  }

  if (host === "onedrive.live.com" || host === "1drv.ms" || host === "sharepoint.com" || host.endsWith(".sharepoint.com")) {
    return (
      "OneDrive and SharePoint links are not supported: they serve a viewer page behind a Microsoft sign-in, never the " +
      `file itself. Download the PDF to your computer, then pass its absolute path as filePath (or its bytes as ` +
      `fileBase64) - up to ${UPLOAD_MAX_LABEL}.`
    );
  }

  return null;
}

export function validateSourceUrl(raw: string, apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError("validation", "sourceUrl must be an absolute URL.");
  }
  const unsupported = unsupportedSourceUrlReason(url);
  if (unsupported) throw new ToolError("validation", unsupported);
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && url.origin === new URL(apiUrl).origin) return url.toString();
  throw new ToolError("validation", "sourceUrl must use https (http is only accepted for the lnkdrp app itself).");
}

/** File name to record on the upload; import-url replaces it with the real one. */
export function fileNameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split("/").filter(Boolean).pop() ?? "";
    const decoded = decodeURIComponent(last).trim().replace(/[\\/:*?"<>|]+/g, "_");
    const base = decoded || "document.pdf";
    return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  } catch {
    return "document.pdf";
  }
}

/** Resolve after `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register `lnkdrp_share_pdf`. */
export function registerSharePdfTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_share_pdf",
    {
      title: "Share a PDF",
      description:
        "Create a lnkdrp share link for a PDF. Pass exactly one of sourceUrl (an https URL the server fetches), " +
        "filePath (an absolute path READ BY THE MCP SERVER ITSELF, so only for a server running on the same machine " +
        "as the file - the best way to share something the human has locally, with no base64 to emit) or fileBase64 " +
        `(the PDF's bytes inline, for a file with no public URL and no local path). Up to ${UPLOAD_MAX_LABEL} either way; ` +
        "note that a hosted deployment may cap request bodies far below that, so a large inline upload can still be " +
        "refused by the platform - sourceUrl never has that problem. On the filePath and fileBase64 paths the PDF is " +
        "shrunk first when that helps and is safe (optimize: false turns it off); the result's optimized field reports " +
        "what happened. Creates the document, imports the file, starts " +
        "processing (preview, text, summary) and returns { docId, shareId, shareUrl, status, uploadId, warnings, creditsRemaining }. " +
        "By default waits up to timeoutSeconds for status ready|failed; if it times out, poll lnkdrp_get_share. Optional: allowDownload, password. " +
        "Each upload's AI summary costs 1 credit, or nothing when you pass summary and keyPoints (write them from the document). " +
        "A skipped AI step (for example out of credits) does not fail the call: the link is still valid and warnings says what was skipped. " +
        "Free workspaces have a cap on shared documents. At the cap this call fails with code plan_limit and creates " +
        "nothing — the error names what you can still do without upgrading, such as adding another link to a document " +
        "that already exists. Below the cap, planWarning appears when the workspace is close to it. " +
        SAFETY_TAIL,
      inputSchema: sharePdfInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args, extra) => {
      const { api } = ctx;
      const source = resolvePdfSource(args, ctx.config.apiUrl);
      const title = (args.title ?? "").trim() || "Untitled document";
      if ((args.summary === undefined) !== (args.keyPoints === undefined)) {
        throw new ToolError("validation", "Pass summary and keyPoints together (both or neither).");
      }
      const orgId = ctx.whoami().orgId;
      const progressToken = extra._meta?.progressToken;

      const run = async (): Promise<SharePdfResult> => {
        // Read (and shrink) local bytes before anything exists server-side: a missing file or a
        // non-PDF then fails with nothing created, exactly like a bad sourceUrl.
        const inline = source.kind === "url" ? null : await prepareInlineUpload(source, { optimize: args.optimize !== false });
        const optimizeFields = inline
          ? { optimized: inline.optimized, ...(inline.optimizeNote ? { optimizeNote: inline.optimizeNote } : {}) }
          : {};

        const created = await api.createDoc({ title });
        const docId = created.doc.id;
        const shareId = created.doc.shareId;
        const shareUrl = shareId ? api.shareUrl(shareId) : null;
        const ids = { docId, shareId, shareUrl };

        // 1. Upload record + import. On failure, remove the empty draft again.
        let uploadId: string;
        let version = 1;
        try {
          const upload = await api.createUpload({
            docId,
            originalFileName: source.kind === "url" ? fileNameFromUrl(source.url) : (inline as InlineUpload).fileName,
            summary: args.summary,
            keyPoints: args.keyPoints,
          });
          uploadId = upload.id;
          version = upload.version ?? 1;
          if (source.kind === "url") await api.importUrl(uploadId, source.url);
          else await api.importBytes(uploadId, (inline as InlineUpload).base64, (inline as InlineUpload).fileName);
        } catch (err) {
          await api.deleteDoc(docId).catch(() => undefined);
          throw err;
        }

        // 2. Everything after this point keeps the doc; report its ids so the agent can recover.
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              await api.processUpload(uploadId);
              break;
            } catch (err) {
              const notReady = isToolError(err) && err.status === 409 && attempt < PROCESS_NOT_READY_RETRIES;
              if (!notReady) throw err;
              await sleep(PROCESS_NOT_READY_DELAY_MS);
            }
          }
          if (args.allowDownload) await api.patchDoc(docId, { shareAllowPdfDownload: true });
          if (args.password) await api.setSharePassword(docId, args.password);

          let status: string = "preparing";
          let timedOut = false;
          if (args.waitForReady) {
            const waited = await waitForDocStatus({
              api,
              docId,
              timeoutMs: args.timeoutSeconds * 1000,
              realtime: { url: ctx.config.realtimeUrl, secretConfigured: ctx.config.realtimeSecretConfigured },
              identity: { userId: ctx.whoami().userId, orgId },
              onTick: ({ elapsedMs, status: current }) => {
                if (progressToken === undefined) return;
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: Math.min(args.timeoutSeconds, Math.round(elapsedMs / 1000)),
                      total: args.timeoutSeconds,
                      message: `processing: ${current}`,
                    },
                  })
                  .catch(() => undefined);
              },
            });
            status = waited.doc.status;
            timedOut = waited.timedOut;
          }

          // AI outcome is only known once processing finished; never fail the call over it.
          const outcome =
            args.waitForReady && !timedOut
              ? await readAiOutcome(api, uploadId, { credits: true })
              : { warnings: [] as string[], creditsRemaining: null };

          return {
            ...ids,
            replaceUrl: null,
            status,
            version,
            uploadId,
            title,
            ...(created.planWarning ? { planWarning: created.planWarning } : {}),
            ...(timedOut ? { timedOut: true as const } : {}),
            ...optimizeFields,
            warnings: outcome.warnings,
            ...(outcome.creditsRemaining !== null ? { creditsRemaining: outcome.creditsRemaining } : {}),
          };
        } catch (err) {
          throw isToolError(err) ? err.withDetails(ids) : err;
        }
      };

      const { value, replayed } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "share_pdf", args.idempotencyKey), run, {
        fingerprint: fingerprintArgs(args),
      });
      if (!replayed) return value;
      // A replay returns the same document; refresh the status so a retry after a timeout is useful.
      const fresh = await api.getDoc(value.docId).catch(() => null);
      return fresh ? { ...value, status: fresh.status, ...(fresh.status === "ready" || fresh.status === "failed" ? { timedOut: undefined } : {}) } : value;
    }),
  );
}
