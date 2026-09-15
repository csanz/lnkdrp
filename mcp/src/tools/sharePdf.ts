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
    .describe("Public https URL of the PDF. Google Drive share links and lnkdrp /s/ links are accepted."),
  allowDownload: z.boolean().default(false).describe("Let viewers download the PDF (default false)."),
  password: z.string().min(8).max(128).optional().describe("Protect the share link with a password (8-128 chars)."),
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
        "Create a lnkdrp share link for a PDF fetched from a public URL. Creates the document, imports the file, starts " +
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
      const sourceUrl = validateSourceUrl(args.sourceUrl, ctx.config.apiUrl);
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
            originalFileName: fileNameFromUrl(sourceUrl),
            summary: args.summary,
            keyPoints: args.keyPoints,
          });
          uploadId = upload.id;
          version = upload.version ?? 1;
          await api.importUrl(uploadId, sourceUrl);
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
