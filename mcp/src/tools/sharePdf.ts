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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PlanWarning } from "../api";
import type { ToolContext } from "../context";
import { handleTool, isToolError, ToolError } from "../errors";
import { IdempotencyStore } from "../idempotency";
import { waitForDocStatus } from "../realtime";
import { readAiOutcome } from "./aiWarnings";
import { SAFETY_TAIL } from "./shared";

const PROCESS_NOT_READY_RETRIES = 5;
const PROCESS_NOT_READY_DELAY_MS = 1000;

/**
 * Decoded-size ceiling for `fileBase64` — mt_bJwX4CtmhU. Small next to the 250MB Blob limit on
 * purpose: this travels as a JSON tool-call argument to the MCP server, then as a JSON request
 * body to the Next app, which is a Vercel Function and hard-caps a request body at 4.5MB
 * regardless of content type. Base64 alone costs ~4/3 of that before the JSON envelope is
 * counted, so 3MB decoded is comfortable margin, not a product choice to keep files small. A
 * file over this still needs sourceUrl.
 */
export const MAX_INLINE_PDF_BYTES = 3 * 1024 * 1024;
/** `MAX_INLINE_PDF_BYTES` as base64 text length, for a fast local reject before any network call. */
export const MAX_INLINE_PDF_BASE64_CHARS = Math.ceil(MAX_INLINE_PDF_BYTES / 3) * 4 + 4;
/**
 * Zod's own `fileBase64` bound — deliberately looser than `MAX_INLINE_PDF_BASE64_CHARS`, and only a
 * backstop against a wildly oversized string, not the real size gate. A schema violation surfaces
 * as a raw MCP protocol error ("-32602: Input validation error"), not a `ToolError`, so a value near
 * the real ceiling (the case a caller will actually hit) must reach `resolvePdfSource` and get the
 * friendly `too_large` message instead of tripping this first. Measured live: setting this equal to
 * `MAX_INLINE_PDF_BASE64_CHARS` made every over-the-real-limit call fail with the terse protocol
 * error instead.
 */
export const FILE_BASE64_SCHEMA_MAX_CHARS = MAX_INLINE_PDF_BASE64_CHARS * 3;

/**
 * Exactly one of `sourceUrl` / `fileBase64` must be given. Validates and normalizes whichever one
 * is present; throws `ToolError("validation", ...)` otherwise, before any upload row is created.
 */
export function resolvePdfSource(
  args: { sourceUrl?: string | undefined; fileBase64?: string | undefined; fileName?: string | undefined },
  apiUrl: string,
): { kind: "url"; url: string } | { kind: "bytes"; base64: string; fileName: string } {
  const hasUrl = typeof args.sourceUrl === "string" && args.sourceUrl.length > 0;
  const hasBytes = typeof args.fileBase64 === "string" && args.fileBase64.length > 0;
  if (hasUrl === hasBytes) {
    throw new ToolError("validation", "Pass exactly one of sourceUrl or fileBase64.");
  }
  if (hasUrl) return { kind: "url", url: validateSourceUrl(args.sourceUrl as string, apiUrl) };
  const base64 = (args.fileBase64 as string).trim();
  if (base64.length > MAX_INLINE_PDF_BASE64_CHARS) {
    throw new ToolError(
      "too_large",
      `fileBase64 decodes to more than ${Math.floor(MAX_INLINE_PDF_BYTES / (1024 * 1024))}MB. Use sourceUrl for a file this size.`,
    );
  }
  return { kind: "bytes", base64, fileName: (args.fileName ?? "").trim() || "document.pdf" };
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
    .describe("Public https URL of the PDF. Google Drive share links and lnkdrp /s/ links are accepted. Exactly one of sourceUrl / fileBase64 is required."),
  fileBase64: z
    .string()
    .min(1)
    .max(FILE_BASE64_SCHEMA_MAX_CHARS)
    .optional()
    .describe(
      `The PDF's bytes, base64-encoded, for a file with no public URL (locally generated, a private attachment). ` +
        `Decoded size up to ${Math.floor(MAX_INLINE_PDF_BYTES / (1024 * 1024))}MB; use sourceUrl instead for anything larger. ` +
        "Exactly one of sourceUrl / fileBase64 is required.",
    ),
  fileName: z.string().max(200).optional().describe("File name to record, only used with fileBase64 (default: document.pdf)."),
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
  /** Skipped or failed AI steps (the link is still valid), e.g. "AI summary skipped: out of AI credits (needs 1). …". */
  warnings: string[];
  /** Workspace credits left after processing, when the snapshot was readable. */
  creditsRemaining?: number;
};

/** Validate the source URL: https anywhere, http only for the lnkdrp app itself (dev). */
export function validateSourceUrl(raw: string, apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError("validation", "sourceUrl must be an absolute URL.");
  }
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
        "Create a lnkdrp share link for a PDF. Pass exactly one of sourceUrl (an https URL the server fetches) or " +
        "fileBase64 (the PDF's bytes, for a file with no public URL yet - locally generated, a private attachment; " +
        "decoded size up to " + Math.floor(MAX_INLINE_PDF_BYTES / (1024 * 1024)) + "MB, use sourceUrl for anything larger). " +
        "Creates the document, imports the file, starts " +
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
            originalFileName: source.kind === "url" ? fileNameFromUrl(source.url) : source.fileName,
            summary: args.summary,
            keyPoints: args.keyPoints,
          });
          uploadId = upload.id;
          version = upload.version ?? 1;
          if (source.kind === "url") await api.importUrl(uploadId, source.url);
          else await api.importBytes(uploadId, source.base64, source.fileName);
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
            warnings: outcome.warnings,
            ...(outcome.creditsRemaining !== null ? { creditsRemaining: outcome.creditsRemaining } : {}),
          };
        } catch (err) {
          throw isToolError(err) ? err.withDetails(ids) : err;
        }
      };

      const { value, replayed } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "share_pdf", args.idempotencyKey), run);
      if (!replayed) return value;
      // A replay returns the same document; refresh the status so a retry after a timeout is useful.
      const fresh = await api.getDoc(value.docId).catch(() => null);
      return fresh ? { ...value, status: fresh.status, ...(fresh.status === "ready" || fresh.status === "failed" ? { timedOut: undefined } : {}) } : value;
    }),
  );
}
