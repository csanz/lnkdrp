/**
 * `lnkdrp_replace_pdf` — put a new PDF on an existing document, keeping every share link.
 *
 * The gap this closes (mt_zKD3mlHp_K): `lnkdrp_share_pdf` can only create a new document, so a
 * Free workspace at its document cap had no way to update a document it had already shared —
 * not because updating is hard, the app has always had a "replace the file" flow, but because no
 * MCP tool drove it. `lnkdrp_share_pdf`'s own `plan_limit` error names "replace the file on an
 * existing document" as the alternative to upgrading; this is that alternative.
 *
 * Flow (all through the REST API with the caller's key):
 *   GET /api/docs/:docId (confirm it exists, read its title/shareId)
 *   → POST /api/uploads { docId } (allocates the next version; this is what flips
 *     `Doc.currentUploadId` and `Doc.status` to "preparing" — immediately, before the file is even
 *     fetched, same as the web app's own replace button)
 *   → POST import-url → POST process → optional PATCH title → optionally wait for ready|failed.
 *
 * Never creates a document and never deletes one: on any failure after the upload record exists,
 * the existing document is left exactly as `POST /api/uploads` and the pipeline left it — see the
 * tool description for what that means while a replacement is in flight or failed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PlanWarning } from "../api";
import type { ToolContext } from "../context";
import { handleTool, isToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { waitForDocStatus } from "../realtime";
import { fileNameFromUrl, FILE_BASE64_SCHEMA_MAX_CHARS, MAX_INLINE_PDF_BYTES, resolvePdfSource } from "./sharePdf";
import { readAiOutcome } from "./aiWarnings";
import { docIdSchema, SAFETY_TAIL } from "./shared";

const PROCESS_NOT_READY_RETRIES = 5;
const PROCESS_NOT_READY_DELAY_MS = 1000;

export const replacePdfInputShape = {
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .describe("Caller-chosen key (1-128 chars). Reusing it within 24h returns the same result instead of replacing again."),
  docId: docIdSchema.describe("The existing document to update. Every one of its share links keeps working and keeps its analytics history."),
  sourceUrl: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("Public https URL of the new PDF. Google Drive share links and lnkdrp /s/ links are accepted. Exactly one of sourceUrl / fileBase64 is required."),
  fileBase64: z
    .string()
    .min(1)
    .max(FILE_BASE64_SCHEMA_MAX_CHARS)
    .optional()
    .describe(
      `The new PDF's bytes, base64-encoded, for a file with no public URL. Decoded size up to ${Math.floor(MAX_INLINE_PDF_BYTES / (1024 * 1024))}MB; ` +
        "use sourceUrl instead for anything larger. Exactly one of sourceUrl / fileBase64 is required.",
    ),
  fileName: z.string().max(200).optional().describe("File name to record, only used with fileBase64 (default: document.pdf)."),
  title: z.string().max(200).optional().describe("New title for the document (optional; leaves it unchanged if omitted)."),
  waitForReady: z.boolean().default(true).describe("Wait until processing finishes (status ready or failed) before returning."),
  timeoutSeconds: z.number().int().min(5).max(120).default(60).describe("Max seconds to wait for processing (5-120, default 60)."),
  summary: z
    .string()
    .min(40)
    .max(600)
    .optional()
    .describe(
      "Your own summary of the new content, written from it (40-600 characters, plain text; URLs and markup are stripped). " +
        "Pass together with keyPoints: the automatic AI summary for this version is then skipped and costs 0 credits.",
    ),
  keyPoints: z
    .array(z.string().min(1).max(160))
    .min(2)
    .max(7)
    .optional()
    .describe("2-7 key points from the new content, each at most 160 characters, plain text. Pass together with summary."),
};

export type ReplacePdfResult = {
  docId: string;
  shareId: string | null;
  shareUrl: string | null;
  status: string;
  /** The new version number this upload became (1 = the document's very first upload). */
  version: number;
  uploadId: string;
  title: string | null;
  planWarning?: PlanWarning;
  /** Present when `waitForReady` gave up before a terminal status; poll `lnkdrp_get_share`. */
  timedOut?: true;
  warnings: string[];
  /** Workspace credits left after processing, when the snapshot was readable. */
  creditsRemaining?: number;
};

/** Resolve after `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register `lnkdrp_replace_pdf`. */
export function registerReplacePdfTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_replace_pdf",
    {
      title: "Replace a document's PDF",
      description:
        "Put a new PDF on an existing document. Every share link keeps its address, its settings and its analytics " +
        "history - recipients open the same URL and see the new file. This is how to update a document you have " +
        "already shared, including on a Free workspace at its document cap: replacing does not create a document, " +
        "so it is never blocked by plan_limit the way lnkdrp_share_pdf is. Pass exactly one of sourceUrl (an https URL " +
        "the server fetches) or fileBase64 (the new PDF's bytes, for a file with no public URL yet; decoded size up to " +
        Math.floor(MAX_INLINE_PDF_BYTES / (1024 * 1024)) + "MB, use sourceUrl for anything larger). Returns { docId, shareId, shareUrl, status, " +
        "version, uploadId, warnings, creditsRemaining }. " +
        "The document's status flips to preparing the moment this call starts, before the new file is even fetched - " +
        "recipients opening a link in that window see 'preparing', same as during the first upload. If import or " +
        "processing then fails, the document is left in that state rather than rolled back to the old file; call " +
        "lnkdrp_get_share to check, or run lnkdrp_replace_pdf again with a working sourceUrl or fileBase64 to finish the update. " +
        "Nothing is ever deleted - the previous version's file and analytics are not affected by a failed attempt. " +
        "By default waits up to timeoutSeconds for status ready|failed; if it times out, poll lnkdrp_get_share. " +
        "Each replacement's AI summary costs 1 credit, or nothing when you pass summary and keyPoints (write them " +
        "from the new content). A skipped AI step does not fail the call: the link is still valid and warnings says " +
        "what was skipped. " +
        SAFETY_TAIL,
      inputSchema: replacePdfInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args, extra) => {
      const { api } = ctx;
      const source = resolvePdfSource(args, ctx.config.apiUrl);
      const orgId = ctx.whoami().orgId;
      const progressToken = extra._meta?.progressToken;

      const run = async (): Promise<ReplacePdfResult> => {
        // Confirms the document exists (and is this workspace's) before anything is created, so a
        // bad docId fails with `not_found` and no upload row, rather than surfacing whatever
        // `POST /api/uploads`'s own doc lookup happens to say.
        const before = await api.getDoc(args.docId);
        const docId = before.id;
        const shareId = before.shareId;
        const shareUrl = shareId ? api.shareUrl(shareId) : null;
        const ids = { docId, shareId, shareUrl };

        // 1. Upload record + import. This is the step that flips the document to "preparing" and
        // points it at the new (not yet fetched) upload — see the tool description. Never delete
        // the document on failure here: unlike lnkdrp_share_pdf's fresh draft, this one has real
        // recipients.
        const upload = await api.createUpload({
          docId,
          originalFileName: source.kind === "url" ? fileNameFromUrl(source.url) : source.fileName,
          summary: args.summary,
          keyPoints: args.keyPoints,
        });
        const uploadId = upload.id;
        const version = upload.version ?? 1;
        // Until the file is accepted the new version never goes live (a failed import puts the
        // document back on its previous version), so an error then reports attemptedVersion, not
        // a version the document is not on.
        let imported = false;
        const withIds = (err: unknown) =>
          isToolError(err) ? err.withDetails({ ...ids, uploadId, ...(imported ? { version } : { attemptedVersion: version }) }) : err;

        try {
          if (source.kind === "url") await api.importUrl(uploadId, source.url);
          else await api.importBytes(uploadId, source.base64, source.fileName);
          imported = true;

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

          const title = args.title?.trim();
          if (title) await api.patchDoc(docId, { title });

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

          const outcome =
            args.waitForReady && !timedOut
              ? await readAiOutcome(api, uploadId, { credits: true })
              : { warnings: [] as string[], creditsRemaining: null };

          return {
            ...ids,
            status,
            version,
            uploadId,
            title: title ?? before.title,
            ...(timedOut ? { timedOut: true as const } : {}),
            warnings: outcome.warnings,
            ...(outcome.creditsRemaining !== null ? { creditsRemaining: outcome.creditsRemaining } : {}),
          };
        } catch (err) {
          throw withIds(err);
        }
      };

      const { value, replayed } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "replace_pdf", args.idempotencyKey), run, {
        fingerprint: fingerprintArgs(args),
      });
      if (!replayed) return value;
      // A replay returns the same result; refresh the status so a retry after a timeout is useful.
      const fresh = await api.getDoc(value.docId).catch(() => null);
      return fresh ? { ...value, status: fresh.status, ...(fresh.status === "ready" || fresh.status === "failed" ? { timedOut: undefined } : {}) } : value;
    }),
  );
}
