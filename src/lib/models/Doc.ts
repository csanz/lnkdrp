/**
 * Doc model.
 *
 * Represents an uploaded document and its derived artifacts/metadata. Includes
 * model hooks that keep `Project.docCount` in sync when docs are moved between
 * projects or archived/deleted.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import { ProjectModel } from "@/lib/models/Project";

const docSchema = new Schema(
  {
    /** Organization tenancy boundary (used for org switching). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, default: null },
    /**
     * Multi-project support:
     * A doc can belong to many projects. `projectId` remains as a backward-compat
     * "primary" pointer, while `projectIds` is the canonical membership list.
     */
    projectIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Project" }],
      index: true,
      default: [],
    },
    // Backward-compat: some older code refers to `uploadId`
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true },
    // New canonical field name
    currentUploadId: { type: Schema.Types.ObjectId, ref: "Upload", index: true },

    /**
     * Canonical object status.
     */
    status: {
      type: String,
      enum: ["draft", "preparing", "ready", "failed"],
      default: "draft",
      index: true,
    },

    /**
     * Public share identifier (safe for URLs).
     * Used for share links like `/share/:shareId` so we never expose Mongo `_id`.
     */
    shareId: { type: String, trim: true, index: true, unique: true },

    title: { type: String, trim: true },

    /**
     * Separate "document name" (AI-inferred) vs. file name.
     * - docName: inferred from the document content (not the upload filename).
     * - fileName: last uploaded filename (denormalized from Upload.originalFileName).
     */
    docName: { type: String, trim: true },
    fileName: { type: String, trim: true },

    // Canonical pointers to current artifacts
    blobUrl: { type: String, trim: true },
    previewImageUrl: { type: String, trim: true },
    extractedText: { type: String },

    // AI results (store JSON like public/sample/sample-ai-output.json)
    aiOutput: { type: Schema.Types.Mixed, default: null },

    // AI-derived per-page slugs (kebab-case)
    pageSlugs: {
      type: [
        {
          pageNumber: { type: Number, min: 1 },
          slug: { type: String, trim: true, default: null },
        },
      ],
      default: [],
    },

    numberOfViews: { type: Number, default: 0, min: 0 },
    numberOfPagesViewed: { type: Number, default: 0, min: 0 },
    // Backward-compat artifact fields (older code)
    firstPagePngUrl: { type: String, trim: true }, // (vercel blob URL)

    // Optional (often derived from Upload, but handy to denormalize)
    // Backward-compat extracted text field
    pdfText: { type: String },

    /**
     * Share-page UX option:
     * If true, the receiver sees a simple "relevance checklist" UI on `/share/:shareId`.
     */
    receiverRelevanceChecklist: { type: Boolean, default: false },

    /**
     * Share-page UX option:
     * If true, show a "Download PDF" button to receivers on `/s/:shareId`.
     *
     * Note: This does not prevent a motivated receiver from saving what they can view,
     * but it controls whether we present an explicit download affordance.
     */
    shareAllowPdfDownload: { type: Boolean, default: false },

    /**
     * Cached metrics snapshot for the owner doc page.
     *
     * This is written by a cron/rollup job so the doc detail page can show a quick
     * metrics glimpse without querying the metrics endpoint.
     */
    metricsSnapshot: {
      updatedAt: { type: Date, default: null },
      days: { type: Number, default: 15, min: 1, max: 60 },
      lastDaysViews: { type: Number, default: 0, min: 0 },
      lastDaysDownloads: { type: Number, default: 0, min: 0 },
      downloadsTotal: { type: Number, default: 0, min: 0 },
    },

    /**
     * Optional password protection for `/share/:shareId`.
     *
     * - Never store plaintext passwords.
     * - When `sharePasswordHash` is present, the share page is gated behind a password.
     */
    sharePasswordSalt: { type: String, default: null },
    sharePasswordHash: { type: String, default: null },
    // Encrypted (reversible) form for owners to view/edit the current password.
    // This is encrypted server-side using a secret and is never exposed publicly.
    sharePasswordEnc: { type: String, default: null },
    sharePasswordEncIv: { type: String, default: null },
    sharePasswordEncTag: { type: String, default: null },

    /**
     * If set, this doc was originally received via a request link repo.
     *
     * This is durable (doesn't change if the doc is later moved into other projects),
     * and is used to show "Intel" (review agent output) instead of owner metrics.
     */
    receivedViaRequestProjectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },

    /**
     * Optional public upload capability token for replacing this doc's file.
     *
     * This is intended for docs received via request links, so the owner can share a
     * replacement upload link that creates a new Upload version for the existing doc.
     */
    replaceUploadToken: { type: String, trim: true, default: null, index: true, unique: true, sparse: true },

    /**
     * If set, this doc is being used as a "Guide" (thesis/RFP/JD) for a request repo.
     *
     * This is written when attaching a guide doc to a request repo so the doc can be
     * linked back to its request context in list/detail UIs.
     */
    guideForRequestProjectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true,
    },

    isArchived: { type: Boolean, default: false, index: true },
    archivedDate: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    // New canonical field name (kept alongside `isDeletedDate` for backward-compat).
    deletedDate: { type: Date, default: null },
    isDeletedDate: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

type DocCountSnap = {
  id: string;
  orgId: string;
  active: boolean;
  projectIds: Set<string>;
};
/** Return whether the given string is a valid Mongo ObjectId. */
function isValidObjectIdString(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}
/** Extract a set of project ids from doc fields (`projectId` + `projectIds`). */
function extractProjectIdSet(doc: { projectId?: unknown; projectIds?: unknown }): Set<string> {
  const ids: string[] = [];
  if (doc.projectId) {
    const s = String(doc.projectId);
    if (isValidObjectIdString(s)) ids.push(s);
  }
  const arr = doc.projectIds;
  if (Array.isArray(arr)) {
    for (const x of arr) {
      const s = String(x);
      if (isValidObjectIdString(s)) ids.push(s);
    }
  }
  return new Set(ids);
}
/** Build a minimal snapshot of a doc needed to update project docCount values. */
function snapDocForCounts(doc: unknown): DocCountSnap | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as {
    _id?: unknown;
    orgId?: unknown;
    projectId?: unknown;
    projectIds?: unknown;
    isArchived?: unknown;
    isDeleted?: unknown;
  };
  const id = d._id ? String(d._id) : "";
  const orgId = d.orgId ? String(d.orgId) : "";
  if (!id || !orgId) return null;
  const active = !Boolean(d.isArchived) && !Boolean(d.isDeleted);
  const projectIds = extractProjectIdSet(d);
  return { id, orgId, active, projectIds };
}
/** Return whether a Mongo update object could change project membership or active state. */
function updateTouchesProjectCounts(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const u = update as Record<string, unknown>;
  const set = (u.$set && typeof u.$set === "object" ? (u.$set as Record<string, unknown>) : null) ?? null;
  const inc = (u.$inc && typeof u.$inc === "object" ? (u.$inc as Record<string, unknown>) : null) ?? null;
  const addToSet =
    (u.$addToSet && typeof u.$addToSet === "object" ? (u.$addToSet as Record<string, unknown>) : null) ?? null;
  const pull = (u.$pull && typeof u.$pull === "object" ? (u.$pull as Record<string, unknown>) : null) ?? null;

  // Direct assignment updates (rare in this codebase, but supported)
  if ("projectId" in u || "projectIds" in u || "isArchived" in u || "isDeleted" in u || "orgId" in u) return true;
  // Common modifier paths
  if (set && ("projectId" in set || "projectIds" in set || "isArchived" in set || "isDeleted" in set || "orgId" in set))
    return true;
  if (addToSet && "projectIds" in addToSet) return true;
  if (pull && "projectIds" in pull) return true;
  // Some flows might soft-delete via $set, but if ever via $inc flags etc, be safe.
  if (inc && ("isArchived" in inc || "isDeleted" in inc)) return true;
  return false;
}

/**
 * Apply a docCount diff to affected projects based on a before/after snapshot.
 * Best-effort: errors are handled by callers/hooks.
 */
async function applyProjectCountDiff(before: DocCountSnap | null, after: DocCountSnap | null): Promise<void> {
  if (!before && !after) return;

  const beforeActive = before?.active ?? false;
  const afterActive = after?.active ?? false;
  const beforeSet = before?.projectIds ?? new Set<string>();
  const afterSet = after?.projectIds ?? new Set<string>();

  const toInc: string[] = [];
  const toDec: string[] = [];

  if (beforeActive && !afterActive) {
    toDec.push(...Array.from(beforeSet));
  } else if (!beforeActive && afterActive) {
    toInc.push(...Array.from(afterSet));
  } else if (beforeActive && afterActive) {
    for (const id of afterSet) if (!beforeSet.has(id)) toInc.push(id);
    for (const id of beforeSet) if (!afterSet.has(id)) toDec.push(id);
  }

  const orgIdStr = after?.orgId ?? before?.orgId ?? "";
  if (!orgIdStr || !isValidObjectIdString(orgIdStr)) return;
  const orgId = new mongoose.Types.ObjectId(orgIdStr);

  if (toInc.length) {
    await ProjectModel.updateMany(
      { _id: { $in: toInc.filter(isValidObjectIdString).map((id) => new mongoose.Types.ObjectId(id)) }, orgId },
      { $inc: { docCount: 1 } },
    );
  }
  if (toDec.length) {
    await ProjectModel.updateMany(
      { _id: { $in: toDec.filter(isValidObjectIdString).map((id) => new mongoose.Types.ObjectId(id)) }, orgId },
      { $inc: { docCount: -1 } },
    );
  }
}

// Model-level trigger: keep Project.docCount in sync whenever doc membership or active state changes.
// This is intentionally best-effort; failures should not block user-facing writes.
for (const op of ["findOneAndUpdate", "updateOne"] as const) {
  docSchema.pre(op, async function () {
    try {
      const update = (this as unknown as { getUpdate?: () => unknown }).getUpdate?.();
      if (!updateTouchesProjectCounts(update)) return;

      const before = await (this as unknown as { model: Model<Doc> }).model
        .findOne((this as unknown as { getQuery: () => Record<string, unknown> }).getQuery())
        .select({ _id: 1, orgId: 1, projectId: 1, projectIds: 1, isArchived: 1, isDeleted: 1 })
        .lean();

      (this as unknown as { _docCountBefore?: DocCountSnap | null })._docCountBefore = snapDocForCounts(before);
    } catch {
      // ignore
    }
  });

  docSchema.post(op, async function () {
    try {
      const before = (this as unknown as { _docCountBefore?: DocCountSnap | null })._docCountBefore ?? null;
      if (!before?.id) return;

      const afterDoc = await (this as unknown as { model: Model<Doc> }).model
        .findById(before.id)
        .select({ _id: 1, orgId: 1, projectId: 1, projectIds: 1, isArchived: 1, isDeleted: 1 })
        .lean();
      const after = snapDocForCounts(afterDoc);

      await applyProjectCountDiff(before, after);
    } catch {
      // ignore (best-effort)
    }
  });
}

docSchema.pre("save", async function () {
  try {
    const doc = this as unknown as {
      isNew: boolean;
      _id?: unknown;
      userId?: unknown;
      orgId?: unknown;
      projectId?: unknown;
      projectIds?: unknown;
      isArchived?: unknown;
      isDeleted?: unknown;
      isModified?: (path: string) => boolean;
    };
    // Only bother when a doc is created or when relevant fields are modified.
    const relevant =
      doc.isNew ||
      Boolean(doc.isModified?.("projectId")) ||
      Boolean(doc.isModified?.("projectIds")) ||
      Boolean(doc.isModified?.("isArchived")) ||
      Boolean(doc.isModified?.("isDeleted")) ||
      Boolean(doc.isModified?.("orgId"));
    if (!relevant) return;

    if (doc.isNew) {
      (doc as unknown as { _docCountBefore?: DocCountSnap | null })._docCountBefore = null;
      return;
    }

    const beforeDoc = await (this.constructor as Model<Doc>)
      .findById(doc._id)
      .select({ _id: 1, orgId: 1, projectId: 1, projectIds: 1, isArchived: 1, isDeleted: 1 })
      .lean();
    (doc as unknown as { _docCountBefore?: DocCountSnap | null })._docCountBefore = snapDocForCounts(beforeDoc);
  } catch {
    // ignore
  }
});

docSchema.post("save", async function () {
  try {
    const doc = this as unknown as {
      _id?: unknown;
      orgId?: unknown;
      projectId?: unknown;
      projectIds?: unknown;
      isArchived?: unknown;
      isDeleted?: unknown;
      _docCountBefore?: DocCountSnap | null;
    };
    const before = doc._docCountBefore ?? null;
    const after = snapDocForCounts(doc);
    await applyProjectCountDiff(before, after);
  } catch {
    // ignore
  }
});

export type Doc = InferSchemaType<typeof docSchema>;

export const DocModel: Model<Doc> = (() => {
  const existing = mongoose.models.Doc as Model<Doc> | undefined;
  if (existing) {
    // In dev, Next/Mongoose can keep an old cached model across edits.
    // If the cached model is missing newer schema paths, rebuild it so updates persist.
    const hasSharePassword =
      Boolean(existing.schema.path("sharePasswordHash")) &&
      Boolean(existing.schema.path("sharePasswordSalt")) &&
      Boolean(existing.schema.path("sharePasswordEnc")) &&
      Boolean(existing.schema.path("sharePasswordEncIv")) &&
      Boolean(existing.schema.path("sharePasswordEncTag"));
    const hasProjectIds = Boolean(existing.schema.path("projectIds"));
    const hasShareAllowPdfDownload = Boolean(existing.schema.path("shareAllowPdfDownload"));
    const hasReplaceUploadToken = Boolean(existing.schema.path("replaceUploadToken"));
    if (
      (!hasSharePassword || !hasProjectIds || !hasShareAllowPdfDownload || !hasReplaceUploadToken) &&
      process.env.NODE_ENV !== "production"
    ) {
      delete mongoose.models.Doc;
    } else {
      return existing;
    }
  }
  return mongoose.model<Doc>("Doc", docSchema);
})();

