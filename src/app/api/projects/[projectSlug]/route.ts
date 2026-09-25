/**
 * API route for `/api/projects/:id`.
 *
 * Update/delete a project. For request repos, also supports updating request review settings.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { newSecretToken, newShareId } from "@/lib/crypto/randomBase62";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { recordActivity } from "@/lib/activity/log";
import { authOrRateLimitResponse } from "@/lib/http/errorResponse";
import { setAllProjectLinksEnabled, syncProjectShareState } from "@/lib/share/projectLinks";
import { removeAllTagsFromTarget } from "@/lib/tags/service";
import { liveProjectByIdMatch } from "@/lib/projects/scope";

export const runtime = "nodejs";

const MAX_PROJECT_NAME_LENGTH = 80;

/**
 * True when another live project in the workspace has this name, ignoring letter case. The unique
 * index is case-sensitive, so "Press kit" and "press KIT" both went in and could not be told apart
 * in any list.
 */
async function projectNameTaken(orgId: Types.ObjectId, name: string, exceptId?: unknown): Promise<boolean> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = await ProjectModel.exists({
    orgId,
    name: { $regex: `^${escaped}$`, $options: "i" },
    isDeleted: { $ne: true },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  return Boolean(hit);
}

function slugify(input: string) {
  return input
    .trim()
    // Fold accents to their base letter ("Série" -> "serie") instead of cutting the word in two.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function ensureUniqueSlug(opts: { orgId: Types.ObjectId; legacyUserId?: Types.ObjectId; base: string }) {
  const base = opts.base || "project";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const exists = await ProjectModel.exists({
      $or: [
        { orgId: opts.orgId, slug: candidate },
        ...(opts.legacyUserId
          ? [
              {
                userId: opts.legacyUserId,
                slug: candidate,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ]
          : []),
      ],
    });
    if (!exists) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function ensureUniqueProjectName(opts: { orgId: Types.ObjectId; legacyUserId?: Types.ObjectId; base: string }) {
  const base = (opts.base || "Project").trim().slice(0, MAX_PROJECT_NAME_LENGTH) || "Project";
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : ` (${i + 1})`;
    const candidate = (base + suffix).slice(0, MAX_PROJECT_NAME_LENGTH);
    const exists = await ProjectModel.exists({
      $or: [
        { orgId: opts.orgId, name: candidate },
        ...(opts.legacyUserId
          ? [
              {
                userId: opts.legacyUserId,
                name: candidate,
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ]
          : []),
      ],
    });
    if (!exists) return candidate;
  }
  return `${base.slice(0, Math.max(1, MAX_PROJECT_NAME_LENGTH - 10))} ${Date.now().toString(36)}`.slice(
    0,
    MAX_PROJECT_NAME_LENGTH,
  );
}

function newProjectShareId() {
  return newShareId();
}

/**
 * A request repo's two capability links — `/r/:requestUploadToken` (upload here) and
 * `/request-view/:requestViewToken` (read what was uploaded) — were mint-once and forever. Nothing
 * in the app, the MCP server or the admin area could replace a live one: every write either
 * created a fresh row or back-filled an empty slot behind an `$exists:false` guard. So once a
 * recipient forwarded the link, or it fell out of an email thread, the owner had no move left —
 * not even deleting the repo, because the public readers did not check `isDeleted` either (fixed
 * in the same pass, see the token lookups under src/app/r and src/app/request-view).
 *
 * Rotation is the fix rather than revocation-to-null, and deliberately so:
 *  - a fresh token cuts off *every* holder of the old one the instant it is written, which is
 *    exactly the "make the leaked link stop working" the owner needs;
 *  - the repo keeps working. `Project`'s pre-validate invariant requires a request repo to carry a
 *    `requestUploadToken`, and `GET /api/requests` finds repos by `isRequest` **or** that token, so
 *    nulling it would either invalidate the row or make the repo vanish from its owner's own list.
 *    Degrading to a new link beats refusing to have one.
 *
 * Same length and alphabet as the original mint in `POST /api/requests` (32 base62 chars).
 */
function newRequestToken() {
  return newSecretToken(32);
}

/** Which of a request repo's two capability tokens a PATCH asked us to replace. */
type RequestTokenRotation = "upload" | "view" | "both";

/**
 * Read `{ rotateRequestTokens }` off the body. Anything that is not one of the three known words —
 * including `true`, which an over-eager client might send — is treated as "not asked for", so a
 * typo can never silently rotate the wrong token or half of a pair.
 */
function parseRequestTokenRotation(raw: unknown): RequestTokenRotation | null {
  if (raw === "upload" || raw === "view" || raw === "both") return raw;
  return null;
}
/**
 * Escape Regex (uses replace).
 */


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Handle PATCH requests.
 */


export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const projectIdParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:id] PATCH", { projectId: projectIdParam });
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not edit it.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as Partial<{
      name: string;
      description: string;
      autoAddFiles: boolean;
      requestReviewEnabled: boolean;
      requestReviewPrompt: string;
      requestRequireAuthToUpload: boolean;
      shareEnabled: boolean;
      rotateRequestTokens: RequestTokenRotation;
    }>;

    // `{ shareEnabled }` on its own is a visibility toggle: it must not require or overwrite the
    // name/description/autoAddFiles the full settings form sends.
    const shareOnly = body.name === undefined && typeof body.shareEnabled === "boolean";
    const rotateRequestTokens = parseRequestTokenRotation(body.rotateRequestTokens);
    // `{ rotateRequestTokens }` on its own is the same shape of partial update as `shareOnly`:
    // "cut off the leaked link" is an emergency button, not the settings form, and it must not be
    // made to carry a name it does not have. Without this the rotate call fell into the
    // "Project name is required" 400 below and there was no way to reach the new code at all.
    const rotateOnly = body.name === undefined && typeof body.shareEnabled !== "boolean" && rotateRequestTokens !== null;
    // Both partial shapes skip the settings half of this handler.
    const omitsSettings = shareOnly || rotateOnly;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const autoAddFiles = typeof body.autoAddFiles === "boolean" ? body.autoAddFiles : false;
    const requestReviewEnabled =
      typeof body.requestReviewEnabled === "boolean" ? body.requestReviewEnabled : false;
    const requestReviewPrompt =
      typeof body.requestReviewPrompt === "string" ? body.requestReviewPrompt.trim() : "";
    const requestRequireAuthToUploadRaw =
      typeof body.requestRequireAuthToUpload === "boolean" ? body.requestRequireAuthToUpload : null;
    if (!omitsSettings && !name) return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less` },
        { status: 400 },
      );
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const project = await ProjectModel.findOne(
      liveProjectByIdMatch(new Types.ObjectId(projectIdParam), orgId, legacyUserId, allowLegacyByUserId),
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    if (typeof body.shareEnabled === "boolean") {
      (project as unknown as { shareEnabled?: boolean }).shareEnabled = body.shareEnabled;
    }
    if (!omitsSettings && project.orgId && name.toLowerCase() !== String(project.name ?? "").toLowerCase()) {
      if (await projectNameTaken(project.orgId as Types.ObjectId, name, project._id)) {
        return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
      }
    }
    if (!omitsSettings) {
      project.name = name;
      // Only fields the caller sent: a rename alone used to reset description to "" and
      // autoAddFiles to false.
      if (typeof body.description === "string") project.description = description;
      if (typeof body.autoAddFiles === "boolean") project.autoAddFiles = autoAddFiles;
    }
    const isRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
    if (isRequest && !omitsSettings) {
      debugLog(1, "[api/projects/:id] PATCH request review settings", {
        projectId: projectIdParam,
        requestReviewEnabled,
        requestReviewPromptChars: requestReviewPrompt.length,
      });
      // `requestReviewPrompt` is optional; when omitted/empty, we run the server-managed default VC review prompts.
      (project as unknown as { requestReviewEnabled?: boolean }).requestReviewEnabled = requestReviewEnabled;
      (project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt = requestReviewPrompt;
      if (typeof requestRequireAuthToUploadRaw === "boolean") {
        (project as unknown as { requestRequireAuthToUpload?: boolean }).requestRequireAuthToUpload =
          requestRequireAuthToUploadRaw;
      }
    }
    // Rotate the request repo's capability tokens. See `newRequestToken` for why this exists and
    // why it is a rotation rather than a revocation. Order matters: this runs *after* the settings
    // block and before `save()`, so one PATCH can turn "require sign-in to upload" on and cut the
    // old link in the same write rather than leaving a window between two requests.
    const rotatedTokens: Array<"upload" | "view"> = [];
    if (rotateRequestTokens) {
      if (!isRequest) {
        // Nothing to rotate, and silently succeeding would tell the caller a leaked link was cut
        // when no such link exists. This is the one place refusing beats degrading.
        return applyTempUserHeaders(
          NextResponse.json({ error: "This project is not a request repository" }, { status: 400 }),
          actor,
        );
      }
      if (rotateRequestTokens === "upload" || rotateRequestTokens === "both") {
        (project as unknown as { requestUploadToken?: string }).requestUploadToken = newRequestToken();
        rotatedTokens.push("upload");
      }
      if (rotateRequestTokens === "view" || rotateRequestTokens === "both") {
        (project as unknown as { requestViewToken?: string }).requestViewToken = newRequestToken();
        rotatedTokens.push("view");
      }
      debugLog(1, "[api/projects/:id] PATCH rotate request tokens", {
        projectId: projectIdParam,
        rotated: rotatedTokens,
      });
    }
    // A public page switched in the same save as a rename belongs in this row too; a switch on its
    // own is the share.updated row below.
    const changedFields = omitsSettings
      ? []
      : (["name", "description", "autoAddFiles", "shareEnabled"] as const).filter((f) => project.isModified(f));
    await project.save();
    // The project share switch is a switch over the project's *links* now that a project can have
    // several (docs/prds/lnkdrp-project-links.md): `Project.shareEnabled` alone would leave
    // `/p/:shareId` resolving through a link row that still says enabled. Marks what it disables,
    // so switching back on does not resurrect a link the sender revoked on its own. Best-effort —
    // a project whose links cannot be reached still saves, and `syncProjectShareState` repairs the
    // flag on the next link edit.
    // What the switch *became*, which is not always what was asked for. Seeded from the document
    // we just saved so the paths that never reach the links (a legacy project with no orgId, or a
    // link write that threw) answer exactly as they did before.
    let effectiveShareEnabled = (project as unknown as { shareEnabled?: unknown }).shareEnabled !== false;
    let effectiveShareId: unknown = (project as unknown as { shareId?: unknown }).shareId ?? null;
    if (typeof body.shareEnabled === "boolean" && project.orgId) {
      try {
        await setAllProjectLinksEnabled({ orgId: project.orgId as Types.ObjectId, projectId: project._id, enabled: body.shareEnabled });
        // The links, not the `save()` above, decide `shareEnabled`: every link
        // `setAllProjectLinksEnabled` touches ends in `syncProjectShareState`, which rewrites the
        // flag in Mongo to "at least one link is active". Switching back on cannot revive a link
        // that has expired, nor one the sender revoked on its own, so the derived value can be
        // false a millisecond after we wrote true; and when the switch changed no link at all,
        // nothing ran the sync and the stale true is still sitting in the row. Sync once here (it
        // is idempotent and cheap) and read the row back, because serialising the in-memory
        // document below told the caller the data room was back up and handed them a `/p/` URL
        // that 404s — which is what they then forward to recipients.
        await syncProjectShareState(project._id);
        const fresh = await ProjectModel.findById(project._id)
          .select({ shareEnabled: 1, shareId: 1 })
          .lean<{ shareEnabled?: unknown; shareId?: unknown } | null>();
        if (fresh) {
          effectiveShareEnabled = fresh.shareEnabled !== false;
          effectiveShareId = fresh.shareId ?? null;
        }
      } catch (err) {
        debugError(1, "[api/projects/:id] PATCH could not apply shareEnabled to project links", {
          projectId: projectIdParam,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (changedFields.length) {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "project.updated",
        projectId: project._id,
        title: project.name ?? null,
        meta: { projectName: project.name ?? null, changed: changedFields },
        request,
      });
    }
    if (typeof body.shareEnabled === "boolean") {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share.updated",
        projectId: project._id,
        title: project.name ?? null,
        // The state the project is actually in, for the same reason the response carries it:
        // a feed row reading "enabled the share link" beside a page that never came back up is
        // the record an owner later trusts when working out when the link stopped working.
        // `requested` keeps the intent when the two differ.
        meta: {
          scope: "project",
          shareEnabled: effectiveShareEnabled,
          ...(effectiveShareEnabled === body.shareEnabled ? {} : { requested: body.shareEnabled }),
        },
        request,
      });
    }
    if (rotatedTokens.length) {
      // Cutting off everyone who holds a link is exactly the kind of thing the owner will later
      // want to find in the feed ("when did that link stop working, and who did it?"). Reuses
      // `share.updated` with a project and no doc — the same row shape the project share switch
      // writes, which `src/lib/activity/labels.ts` already renders as "updated sharing for
      // project X". The token values are never written to the feed.
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share.updated",
        projectId: project._id,
        title: project.name ?? null,
        meta: { scope: "requestTokens", rotated: rotatedTokens },
        request,
      });
    }
    if (isRequest) {
      debugLog(1, "[api/projects/:id] PATCH request review saved", {
        projectId: projectIdParam,
        requestReviewEnabled: Boolean((project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled),
        requestReviewPromptChars:
          typeof (project as unknown as { requestReviewPrompt?: unknown }).requestReviewPrompt === "string"
            ? String((project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt ?? "").length
            : 0,
      });
    }

    const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
    const token = typeof tokenRaw === "string" && tokenRaw.trim() ? tokenRaw.trim() : "";
    const requestUploadPath = token ? `/request/${encodeURIComponent(token)}` : null;

    return applyTempUserHeaders(
      NextResponse.json({
        project: {
          id: String(project._id),
          shareId: effectiveShareId,
          shareEnabled: effectiveShareEnabled,
          name: project.name ?? "",
          slug: project.slug ?? "",
          description: project.description ?? "",
          docCount: (function () {
            const raw = (project as unknown as { docCount?: unknown }).docCount;
            return Number.isFinite(raw) ? Number(raw) : 0;
          })(),
          autoAddFiles: Boolean(project.autoAddFiles),
          isRequest,
          request: isRequest
            ? {
                // Already the *new* link after a rotation — this is read off the saved document,
                // and the owner is the only one who ever sees this response.
                uploadPath: requestUploadPath,
                // Which tokens this call replaced, so the caller can say "the old link no longer
                // works" without guessing. Never the token values themselves for the view link:
                // the app reads that back from `GET /api/projects/:id/docs`, as it did before.
                tokensRotated: rotatedTokens,
                requireAuthToUpload: Boolean(
                  (project as unknown as { requestRequireAuthToUpload?: unknown }).requestRequireAuthToUpload,
                ),
                reviewEnabled: Boolean((project as unknown as { requestReviewEnabled?: unknown }).requestReviewEnabled),
                reviewPrompt:
                  typeof (project as unknown as { requestReviewPrompt?: unknown }).requestReviewPrompt === "string"
                    ? String((project as unknown as { requestReviewPrompt?: string }).requestReviewPrompt ?? "")
                    : "",
                guideDocId: (function () {
                  const raw = (project as unknown as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
                  return raw ? String(raw) : null;
                })(),
              }
            : null,
        },
      }),
      actor,
    );
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    const message = err instanceof Error ? err.message : "Unknown error";
    // Surface a clean message for duplicate-name per user.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    debugError(1, "[api/projects/:slug] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle DELETE requests.
 */


export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ projectSlug: string }> },
) {
  try {
    const { projectSlug } = await ctx.params;
    const projectIdParam = decodeURIComponent(projectSlug).trim();

    debugLog(1, "[api/projects/:id] DELETE", { projectId: projectIdParam });
    const actor = await resolveActor(request);
    // Viewers can read a workspace but must not delete from it.
    const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "member" });
    if (!roleCheck.ok) {
      return applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor);
    }
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docTenant = allowLegacyByUserId
      ? {
          $or: [
            { orgId },
            { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { orgId };

    const body = (await request.json().catch(() => null)) as
      | null
      | undefined
      | {
          requestDocsMode?: unknown;
        };
    const requestDocsModeRaw = body && typeof body === "object" ? body.requestDocsMode : null;
    const requestDocsMode =
      typeof requestDocsModeRaw === "string" ? requestDocsModeRaw.trim().toLowerCase() : "";
    const requestDeleteMode =
      requestDocsMode === "delete_docs" || requestDocsMode === "orphan" || requestDocsMode === "copy_to_new_project"
        ? (requestDocsMode as "delete_docs" | "orphan" | "copy_to_new_project")
        : null;

    if (!Types.ObjectId.isValid(projectIdParam)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    const project = await ProjectModel.findOne(
      liveProjectByIdMatch(new Types.ObjectId(projectIdParam), orgId, legacyUserId, allowLegacyByUserId),
    );
    if (!project) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const projectId = new Types.ObjectId(String(project._id));
    const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
    const token = typeof tokenRaw === "string" && tokenRaw.trim() ? tokenRaw.trim() : "";
    const isRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest) || Boolean(token);

    // For request repos, optionally allow controlling what happens to docs.
    if (isRequest && requestDeleteMode) {
      debugLog(1, "[api/projects/:id] DELETE request repo mode", { projectId: projectIdParam, requestDeleteMode });

      // All docs that were uploaded into this request repo (durable pointer) and any attached guide doc.
      // `$and`, not a spread: docTenant carries its own `$or` (legacy personal scope), and a second
      // `$or` key in the same object replaced it, dropping the workspace filter entirely.
      const requestDocs = await DocModel.find({
        $and: [
          docTenant,
          { isDeleted: { $ne: true } },
          {
            $or: [
              { receivedViaRequestProjectId: projectId },
              { guideForRequestProjectId: projectId },
              { primaryProjectId: projectId },
              { projectId },
              { projectIds: projectId },
            ],
          },
        ],
      })
        .select({ _id: 1, primaryProjectId: 1, projectId: 1 })
        .lean();

      if (requestDeleteMode === "copy_to_new_project") {
        const baseName = `${project.name ?? "Request"} (imported)`;
        const name = await ensureUniqueProjectName({
          orgId,
          legacyUserId: allowLegacyByUserId ? legacyUserId : undefined,
          base: baseName,
        });
        const slug = await ensureUniqueSlug({
          orgId,
          legacyUserId: allowLegacyByUserId ? legacyUserId : undefined,
          base: slugify(name),
        });
        const created = await ProjectModel.create({
          orgId,
          userId: legacyUserId,
          shareId: newProjectShareId(),
          name,
          slug,
          description: "",
          autoAddFiles: false,
          isRequest: false,
          requestUploadToken: null,
          requestViewToken: null,
          requestRequireAuthToUpload: false,
          requestReviewEnabled: false,
          requestReviewPrompt: "",
          requestReviewGuideDocId: null,
          isDeleted: false,
        });
        const newProjectId = new Types.ObjectId(String((created as unknown as { _id: Types.ObjectId })._id));

        /**
         * Move each document with two updates, not one. `$addToSet` and `$pull` on the same
         * `projectIds` path in a single update is a Mongo `ConflictingUpdateOperators` error, so
         * this loop failed on the first document, every time, after the project above had already
         * been created: the request repo stayed, the "(imported)" project sat empty, and each
         * retry made "(imported) (2)", "(3)"... against the Free project cap.
         *
         * If the loop fails now (a transient database error is what is left), the project it was
         * filling is removed again so a retry starts clean instead of leaving another orphan. The
         * documents already moved keep their new membership; the retry moves the rest.
         */
        try {
          for (const d of requestDocs) {
            const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
            if (!docId) continue;

            const currentPrimary =
              (d as unknown as { primaryProjectId?: unknown }).primaryProjectId ??
              (d as unknown as { projectId?: unknown }).projectId;
            const primaryIsRequest = currentPrimary ? String(currentPrimary) === String(projectId) : false;
            const nextPrimary = primaryIsRequest || !currentPrimary ? newProjectId : currentPrimary;

            const docFilter = { _id: docId, ...docTenant, isDeleted: { $ne: true } };
            await DocModel.updateOne(docFilter, {
              $set: {
                primaryProjectId: nextPrimary,
                projectId: nextPrimary,
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
              $pull: { projectIds: projectId },
            });
            await DocModel.updateOne(docFilter, { $addToSet: { projectIds: newProjectId } });
          }
        } catch (err) {
          debugLog(1, "[api/projects/:id] DELETE copy_to_new_project failed; removing the new project", {
            projectId: projectIdParam,
            newProjectId: String(newProjectId),
            error: err instanceof Error ? err.message : String(err),
          });
          await ProjectModel.deleteOne({ _id: newProjectId }).catch(() => undefined);
          throw err;
        }
      } else if (requestDeleteMode === "orphan") {
        for (const d of requestDocs) {
          const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
          if (!docId) continue;
          await DocModel.updateOne(
            { _id: docId, ...docTenant, isDeleted: { $ne: true } },
            {
              $set: {
                primaryProjectId: null,
                projectId: null,
                projectIds: [],
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
            },
          );
        }
      } else if (requestDeleteMode === "delete_docs") {
        const now = new Date();
        for (const d of requestDocs) {
          const docId = d && typeof d === "object" && "_id" in d ? (d as { _id?: unknown })._id : null;
          if (!docId) continue;
          await DocModel.updateOne(
            { _id: docId, ...docTenant, isDeleted: { $ne: true } },
            {
              $set: {
                isDeleted: true,
                deletedDate: now,
                primaryProjectId: null,
                projectId: null,
                projectIds: [],
                receivedViaRequestProjectId: null,
                guideForRequestProjectId: null,
              },
            },
          );
        }
      }
    }

    // Remove project membership from docs (best-effort).
    await DocModel.updateMany(
      { $and: [docTenant, { $or: [{ projectId }, { primaryProjectId: projectId }] }] },
      { $set: { primaryProjectId: null, projectId: null } },
    );
    await DocModel.updateMany(
      { ...docTenant, projectIds: projectId },
      { $pull: { projectIds: projectId } },
    );
    // If a doc lost its primary but still has membership, set primary to first remaining projectId.
    try {
      await DocModel.collection.updateMany(
        {
          ...(docTenant as Record<string, unknown>),
          primaryProjectId: null,
          projectId: null,
          projectIds: { $exists: true, $ne: [] },
        },
        [{ $set: { primaryProjectId: { $arrayElemAt: ["$projectIds", 0] }, projectId: { $arrayElemAt: ["$projectIds", 0] } } }],
      );
    } catch {
      // ignore; best-effort
    }

    await ProjectModel.deleteOne({ _id: projectId, ...docTenant });

    // The project row is gone for good (this delete is not a soft one), so its tag assignments
    // have nothing left to point at (src/lib/tags/service.ts).
    void removeAllTagsFromTarget({ orgId: actor.orgId, targetKind: "project", targetId: projectId }).catch(() => {});
    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "project.deleted",
      projectId,
      title: project.name ?? null,
      meta: { projectName: project.name ?? null, ...(isRequest ? { requestRepo: true } : {}) },
      request,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const authOrLimited = authOrRateLimitResponse(err);
    if (authOrLimited) return authOrLimited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/projects/:slug] DELETE failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}



