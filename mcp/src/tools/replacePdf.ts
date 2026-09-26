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

import type { ApiClient, ApiDoc, PlanWarning, UploadAi } from "../api";
import type { ToolContext } from "../context";
import { handleTool, isToolError, ToolError } from "../errors";
import { fingerprintArgs, IdempotencyStore } from "../idempotency";
import { waitForDocStatus } from "../realtime";
import { UPLOAD_MAX_LABEL } from "../../../src/lib/limits/uploads";
import { INLINE_BASE64_SCHEMA_MAX_CHARS, INLINE_SEND_MAX_LABEL, INLINE_UPLOAD_MAX_LABEL } from "../inlineLimits";
import type { OptimizeReport } from "../optimize";
import { fileNameFromUrl, type InlineUpload, prepareInlineUpload, resolvePdfSource } from "./sharePdf";
import { readAiOutcome } from "./aiWarnings";
import { docIdSchema, SAFETY_TAIL, existsUnlessNotFound } from "./shared";

const PROCESS_NOT_READY_RETRIES = 5;
const PROCESS_NOT_READY_DELAY_MS = 1000;
/** How often the superseded path polls this call's own upload row; only used off the happy path. */
const OWN_UPLOAD_POLL_MS = 1000;

export const replacePdfInputShape = {
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Caller-chosen key (1-128 chars). Reusing it within 24h returns the same result instead of replacing again, marked " +
        "replayed: true so you can tell a retry from a second version; the same key with different arguments is refused.",
    ),
  docId: docIdSchema.describe(
    "The existing document to update. Every one of its share links keeps working and keeps its analytics history " +
      "(an archived document's links stay dead until it is brought back; the reply says docArchived: true).",
  ),
  sourceUrl: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      `Public https URL of the new PDF, up to ${UPLOAD_MAX_LABEL}. Google Drive share links and lnkdrp /s/ links are accepted. ` +
        "Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  fileBase64: z
    .string()
    .min(1)
    .max(INLINE_BASE64_SCHEMA_MAX_CHARS)
    .optional()
    .describe(
      `The new PDF's bytes, base64-encoded, for a file with no public URL. Decoded size up to ${INLINE_UPLOAD_MAX_LABEL} ` +
        `before optimization, under ${INLINE_SEND_MAX_LABEL} after it on a hosted deployment. ` +
        "Prefer filePath when the file is already on this machine. Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  filePath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Absolute path to the new PDF, read from disk BY THE MCP SERVER - so this only works when the server runs on the " +
        "same machine as the file (otherwise the call is refused with a validation error telling you to use sourceUrl). " +
        `Expand ~ yourself: /Users/you/Downloads/deck.pdf. Up to ${INLINE_UPLOAD_MAX_LABEL} before optimization. ` +
        "Exactly one of sourceUrl / fileBase64 / filePath is required.",
    ),
  optimize: z
    .boolean()
    .default(true)
    .describe(
      "Shrink the PDF before uploading by downsampling its images (default true; needs Ghostscript on the MCP server). " +
        "Skipped under 1MB; the original is kept whenever the result is not smaller, not a valid PDF, or has a different " +
        "page count, so a page can never be lost. The result's `optimized` field says what happened.",
    ),
  fileName: z
    .string()
    .max(200)
    .optional()
    .describe("File name to record, used with fileBase64 or to override filePath's own basename (default: document.pdf)."),
  title: z.string().max(200).optional().describe("New title for the document (optional; leaves it unchanged if omitted)."),
  waitForReady: z.boolean().default(true).describe("Wait until processing finishes (status ready or failed) before returning."),
  timeoutSeconds: z.number().int().min(5).max(120).default(60).describe("Max seconds to wait for processing (5-120, default 60)."),
  summary: z
    .string()
    .min(40, "summary must be 40-600 characters, and goes together with keyPoints (2-7 items). Omit both to let lnkdrp write the summary instead, which costs credits.")
    .max(600, "summary must be 40-600 characters. Trim it, or omit summary and keyPoints to let lnkdrp write one (costs credits).")
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
  /** How much the new PDF shrank before upload (`fileBase64` / `filePath` only); see `optimizeNote`. */
  optimized?: OptimizeReport | null;
  /** Why the original was sent unchanged (no Ghostscript, already small, `optimize: false`, …). */
  optimizeNote?: string;
  warnings: string[];
  /** Workspace credits left after processing, when the snapshot was readable. */
  creditsRemaining?: number;
  /** The new file's text matched the previous version: a new version number, the same document. */
  unchangedFromPrevious?: true;
  /** The document is archived, so the `shareUrl` in this same reply resolves for nobody. */
  docArchived?: true;
  /**
   * Another replacement won: the document, and so the `shareUrl` above, is on this upload, not on
   * the `version`/`uploadId` this call stored. This call's version still exists in the history.
   */
  supersededBy?: { uploadId: string; version: number | null };
  /** This `idempotencyKey` had already run: the same result, not a second upload. */
  replayed?: true;
};

/**
 * Said in the same reply as the shareUrl, because that URL is what the agent is about to send.
 *
 * Archiving is a property of the document, and the replace succeeds on an archived one by design:
 * `POST /api/uploads` guards only `isDeleted`, and preparing a version before bringing a document
 * back is a legitimate thing to do. What was wrong was the report. This tool returned `status:
 * "ready"`, the new version and a shareUrl with `warnings: []`, so the agent's next sentence to its
 * human was "updated, here is the link" about a URL that 404s for every recipient, while
 * `lnkdrp_create_share_link` and `lnkdrp_update_share_link`, called on the same document a moment
 * later, said `docArchived: true` and refused to call the link active. `status` here is the
 * processing status, not whether anything resolves, so nothing else in the payload carried it.
 *
 * `docArchived` rather than `isArchived`, matching the two link-write tools, because this payload's
 * other flags (`status`, `unchangedFromPrevious`) are about the upload: the thing that is archived
 * is the document behind it. Its own sentence rather than the one in ./shareLinks, in the way
 * `setShareAccess` writes its own: each tool names the remedy for what *it* just did, and what this
 * one just did is store a version nobody can open yet.
 */
const ARCHIVED_DOC_WARNING =
  "This document is archived, so none of its links resolve: anyone opening this shareUrl gets \"not found\". The new " +
  "version is stored and every link keeps its own settings, so lnkdrp_archive_doc { archived: false } brings the " +
  "document and its links back on this new version. Tell the human before they send it.";

/**
 * Archive state as of this reply, plus the sentence that goes with it.
 *
 * Shared by the fresh return and the replay, and it strips before it adds so a replay cannot carry
 * a stale sentence: a key replayed after the document was brought back would otherwise repeat the
 * cached warning about a link that resolves again, and one archived in between would replay the
 * cached silence. `docArchived: undefined` clears the cached flag the same way; `JSON.stringify`
 * drops the key.
 */
function archiveFields(isArchived: boolean, warnings: string[]): { docArchived: true | undefined; warnings: string[] } {
  const rest = warnings.filter((w) => w !== ARCHIVED_DOC_WARNING);
  return isArchived ? { docArchived: true as const, warnings: [ARCHIVED_DOC_WARNING, ...rest] } : { docArchived: undefined, warnings: rest };
}

/**
 * Said in the same reply as the shareUrl, for the same reason `docArchived` is: that URL is what the
 * agent is about to send, and this is the other way it can serve something other than what this call
 * uploaded.
 *
 * Two replacements can overlap on one document (two agents, or an agent while the owner clicks
 * "replace the file"). Both succeed and both get their own version number, and the server settles
 * which one the document lands on: `updateDocUnlessSuperseded` in the process route skips the doc
 * write when a newer upload is already current, leaving the losing upload row completed and in the
 * version history. The loser's *report* was the thing that had never been told. It waited with
 * `waitForDocStatus`, which resolves on the DOCUMENT's status, so a status some other upload caused
 * came back next to this call's own version and the shared shareUrl with `warnings: []`, and the
 * agent's next sentence to its human was "updated, here is the link" about a link serving the other
 * file. Nothing was lost, only mis-reported.
 *
 * The check is a stable fact rather than a guess at liveness: `doc.currentUploadId` is already in
 * the reply the wait just read, and a document that has moved past this version never moves back.
 */
const SUPERSEDED_WARNING_PREFIX = "Another replacement has taken this document over";

/** The sentence for a losing replacement, naming both versions so the agent can say which is live. */
function supersededWarning(version: number, doc: ApiDoc): string {
  const live = doc.version !== null ? `version ${doc.version}` : "a newer version";
  return (
    `${SUPERSEDED_WARNING_PREFIX}: the shareUrl serves ${live} from another replacement, not the version ${version} ` +
    `this call uploaded. Version ${version} was stored and stays in the document's version history, but nobody ` +
    "opening the link will see it. Do not tell the human the file you sent is the live one; call lnkdrp_replace_pdf " +
    "again if it should be."
  );
}

/**
 * Supersede state as of this reply, plus the sentence that goes with it.
 *
 * Shaped like `archiveFields` and for the same reason: it strips its own sentence before it adds
 * one, so a replay cannot carry a stale verdict, and `supersededBy: undefined` clears the cached
 * field the way `JSON.stringify` drops the key. A null `currentUploadId` is not a supersede: the
 * document simply has no current upload to compare against, and inventing a warning from that would
 * be worse than saying nothing.
 */
function supersededFields(
  doc: ApiDoc | null,
  uploadId: string,
  version: number,
  warnings: string[],
): { supersededBy: { uploadId: string; version: number | null } | undefined; warnings: string[] } {
  const rest = warnings.filter((w) => !w.startsWith(SUPERSEDED_WARNING_PREFIX));
  const current = doc?.currentUploadId ?? null;
  if (!doc || !current || current === uploadId) return { supersededBy: undefined, warnings: rest };
  return { supersededBy: { uploadId: current, version: doc.version }, warnings: [supersededWarning(version, doc), ...rest] };
}

/**
 * The upload pipeline's own vocabulary (`uploading|uploaded|processing|completed|failed`) in the
 * document's (`preparing|ready|failed`), so `status` means the same thing to a caller whichever row
 * it was read from. Nothing else in this payload speaks the upload's dialect and a caller comparing
 * against "ready" should not have to learn a second one.
 */
function docStatusFromUpload(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === "completed") return "ready";
  if (status === "failed") return "failed";
  return "preparing";
}

/**
 * Wait for THIS call's upload row to finish, once the document has moved on to someone else's.
 *
 * Only reached off the happy path. The document-level wait is satisfied the moment the document is
 * terminal, which under a race is a state another upload caused, so this call's own row can still be
 * mid-process. Returning then would report the other upload's status as this one's and, worse, would
 * have `readAiOutcome` read a half-written row for `unchangedFromPrevious`, `failureReason` and the
 * credit figure. A read that fails is treated as "not terminal yet" rather than as an error: this is
 * a report detail, and the replace itself has already happened.
 */
async function waitForOwnUpload(api: ApiClient, uploadId: string, deadlineMs: number): Promise<{ status: string | null; timedOut: boolean }> {
  for (;;) {
    const own = await api.getUpload(uploadId).catch(() => null);
    const status = docStatusFromUpload(own?.status);
    if (status === "ready" || status === "failed") return { status, timedOut: false };
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return { status, timedOut: true };
    await sleep(Math.min(OWN_UPLOAD_POLL_MS, remaining));
  }
}

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
        "history - recipients open the same URL and see the new file, unless the document is archived, in which case " +
        "the reply says docArchived: true and nothing resolves until lnkdrp_archive_doc { archived: false }. This is how to update a document you have " +
        "already shared, including on a Free workspace at its document cap: replacing does not create a document, " +
        "so it is never blocked by plan_limit the way lnkdrp_share_pdf is. Pass exactly one of sourceUrl (an https URL " +
        "the server fetches), filePath (an absolute path READ BY THE MCP SERVER ITSELF, so only for a server running on " +
        "the same machine as the file) or fileBase64 (the new PDF's bytes inline). " +
        `sourceUrl takes a PDF up to ${UPLOAD_MAX_LABEL}. filePath and fileBase64 take up to ${INLINE_UPLOAD_MAX_LABEL} and, on a hosted ` +
        `deployment, must come out under ${INLINE_SEND_MAX_LABEL} after optimization or the call refuses with too_large and says ` +
        "to use sourceUrl, which never has that problem. On the filePath " +
        "and fileBase64 paths the PDF is shrunk first when that helps and is safe (optimize: false turns it off); the " +
        "result's optimized field reports what happened. Returns { docId, shareId, shareUrl, status, " +
        "version, uploadId, optimized, warnings, creditsRemaining }. "
        + "unchangedFromPrevious: true means the new file reads the same as the one it replaced - a new version number "
        + "over identical content. Say so rather than reporting the document as updated; it is usually a re-sent file. "
        + "supersededBy means another replacement landed on this document while this one ran: the version here was "
        + "stored and is in the history, but the shareUrl serves that other version, so do not report this file as the "
        + "live one. " +
        "The document's status flips to preparing the moment this call starts, before the new file is even fetched - " +
        "recipients opening a link in that window see 'preparing', same as during the first upload. If import or " +
        "processing then fails, the document goes back to its previous version and to ready - it is not left stuck in " +
        "preparing, and there is nothing to clean up; fix the source and call again when you have one that works. " +
        "Nothing is ever deleted - the previous version's file and analytics are not affected by a failed attempt. " +
        "By default waits up to timeoutSeconds for status ready|failed; if it times out, poll lnkdrp_get_share. " +
        "Each replacement's AI summary costs credits, or nothing when you pass summary and keyPoints (write them " +
        "from the new content). The AI compare against the previous version (what changed, page by page) runs on " +
        "every replacement and costs credits at the workspace's default tier whether or not you pass a summary - " +
        "see costs.compare.perLevel in lnkdrp_whoami; short of credits it is skipped, never blocking the replace. A skipped AI step does not fail the call: the link is still valid and warnings says " +
        "what was skipped. " +
        SAFETY_TAIL,
      inputSchema: replacePdfInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args, extra) => {
      const { api } = ctx;
      const source = resolvePdfSource(args, ctx.config.apiUrl);
      // The same pairing lnkdrp_share_pdf enforces, and it was missing here: half the pair is not a
      // cheaper summary, it is a summary the pipeline cannot use. Checked before the fetch, so a
      // caller that got it wrong finds out from the argument rather than from a file error later.
      if ((args.summary === undefined) !== (args.keyPoints === undefined)) {
        throw new ToolError("validation", "Pass summary and keyPoints together (both or neither).");
      }
      const orgId = ctx.whoami().orgId;
      const progressToken = extra._meta?.progressToken;

      const run = async (): Promise<ReplacePdfResult> => {
        // Confirms the document exists (and is this workspace's) before anything is created, so a
        // bad docId fails with `not_found` and no upload row, rather than surfacing whatever
        // `POST /api/uploads`'s own doc lookup happens to say.
        // Read (and shrink) local bytes first: a missing file or a non-PDF then fails before the
        // document is flipped to "preparing", leaving the live one untouched.
        const inline =
          source.kind === "url" ? null : await prepareInlineUpload(source, { optimize: args.optimize !== false, apiUrl: ctx.config.apiUrl });
        const optimizeFields = inline
          ? { optimized: inline.optimized, ...(inline.optimizeNote ? { optimizeNote: inline.optimizeNote } : {}) }
          : {};

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
          originalFileName: source.kind === "url" ? fileNameFromUrl(source.url) : (inline as InlineUpload).fileName,
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
          else await api.importBytes(uploadId, (inline as InlineUpload).base64, (inline as InlineUpload).fileName);
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
          // The document as of the end of the wait, which is the only read that can tell whether the
          // document ended up on THIS upload. Null when nothing was waited for: there is no verdict
          // to give then (the file has not even been fetched), and `before.currentUploadId` is the
          // previous version, which would make every no-wait call look superseded.
          let latest: ApiDoc | null = null;
          const waitDeadline = Date.now() + args.timeoutSeconds * 1000;
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
            latest = waited.doc;
            // The wait above answers "is the DOCUMENT done", not "is this upload done". When another
            // replacement has taken the document over, that answer belongs to its file, so `status`
            // is re-read from this call's own row and the AI outcome below waits for it too rather
            // than reading a row that is still being written.
            if (latest.currentUploadId && latest.currentUploadId !== uploadId) {
              const own = await waitForOwnUpload(api, uploadId, waitDeadline);
              if (own.status) status = own.status;
              timedOut = own.timedOut;
            }
          }

          const outcome =
            args.waitForReady && !timedOut
              ? await readAiOutcome(api, uploadId, { credits: true })
              : {
                  warnings: [] as string[],
                  creditsRemaining: null,
                  ai: null as UploadAi | null,
                  failureReason: null as string | null,
                  unchangedFromPrevious: false,
                };

          const superseded = supersededFields(latest, uploadId, version, outcome.warnings);

          return {
            ...ids,
            status,
            version,
            uploadId,
            title: title ?? before.title,
            ...(timedOut ? { timedOut: true as const } : {}),
            ...optimizeFields,
            // A failed version says why here, not only inside warnings: an agent that reads status
            // "failed" needs the reason in the same breath to tell the human what to do next.
            ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
            // The one fact that separates a real update from a no-op. A byte-identical replace
            // otherwise returns {status: "ready", version: N+1, warnings: []}, indistinguishable
            // from a new file, and the agent tells its human the document had been updated.
            //
            // This read ai.summary === "unchanged", which is the summary step's state, not the
            // compare's verdict, and the two only coincide when lnkdrp writes the summary. Pass
            // summary + keyPoints — the credit-free path this tool's own description recommends —
            // and the process route overwrites that state with "done" plus summaryBy, so the flag
            // could never fire on the recommended path even though the same run recorded "No
            // changes: this version reads the same as the previous one". The upload row carries its
            // own unchangedFromPrevious, set from the text compare and independent of who wrote the
            // summary; that is what is read now, so the answer no longer depends on how the caller
            // paid for the summary.
            ...(outcome.unchangedFromPrevious ? { unchangedFromPrevious: true as const } : {}),
            // The other way the shareUrl in this reply serves something else. Read off the same doc
            // the wait already fetched, so it costs no extra call.
            supersededBy: superseded.supersededBy,
            // `before` was read before the upload and already carries this; the flag was simply
            // thrown away, so the one fact that decides whether the shareUrl above is worth sending
            // was the one fact the reply did not mention.
            ...archiveFields(before.isArchived, superseded.warnings),
            ...(outcome.creditsRemaining !== null ? { creditsRemaining: outcome.creditsRemaining } : {}),
          };
        } catch (err) {
          throw withIds(err);
        }
      };

      const { value, replayed } = await ctx.idempotency.run(IdempotencyStore.key(orgId, "replace_pdf", args.idempotencyKey, ctx.whoami().credentialId), run, {
        fingerprint: fingerprintArgs(args),
        // The sibling 0fd858a wired into share_pdf and create_project and missed here: a document
        // deleted between the two calls is not one to hand back as a fresh success.
        stillExists: (cached) => existsUnlessNotFound(() => api.getDoc(cached.docId)),
      });
      if (!replayed) return value;
      // A replay returns the same result; refresh the status so a retry after a timeout is useful.
      // `replayed` is said out loud: without it an agent that retried after a network error reads a
      // second identical success and reports two versions uploaded when only one was.
      const fresh = await api.getDoc(value.docId).catch(() => null);
      if (!fresh) return { ...value, replayed: true as const };
      const superseded = supersededFields(fresh, value.uploadId, value.version, value.warnings);
      return {
        ...value,
        replayed: true as const,
        // The document's status is this call's status only while the document is still on this
        // call's upload. Once another replacement has taken it over, refreshing from the doc would
        // answer about that file, so the cached status stays: it is stale, but it is at least about
        // the right upload, and the warning below says which version the link actually serves.
        ...(superseded.supersededBy
          ? {}
          : { status: fresh.status, ...(fresh.status === "ready" || fresh.status === "failed" ? { timedOut: undefined } : {}) }),
        supersededBy: superseded.supersededBy,
        // Archiving is refreshed off the same read for the same reason the status is: the
        // cached answer is as old as the first call, and this one is about whether the URL in
        // this reply resolves right now.
        ...archiveFields(fresh.isArchived, superseded.warnings),
      };
    }),
  );
}
