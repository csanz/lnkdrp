/**
 * Project model.
 *
 * A project groups docs for an owner. Projects have a public share id (`/p/:shareId`)
 * and a private per-user slug (`/project/:slug`).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const projectSchema = new Schema(
  {
    /** Organization tenancy boundary (used for org switching). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    /**
     * Public identifier for project sharing: `/p/:shareId`
     *
     * This is NOT secret; it’s just a public slug.
     */
    shareId: { type: String, trim: true, index: true, unique: true },
    /** Whether `/p/:shareId` resolves. Off = visitors see "This project is no longer shared". */
    shareEnabled: { type: Boolean, default: true },
    name: { type: String, trim: true, required: true },
    slug: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: "" },
    /**
     * Cached count of active (non-deleted, non-archived) docs in this project.
     *
     * This is intentionally maintained by write-paths (doc add/remove/archive/delete)
     * to avoid doing a count lookup when rendering project lists.
     */
    docCount: { type: Number, default: 0, min: 0 },
    /**
     * If true, the AI is allowed to automatically route newly-uploaded docs
     * into this project based on the project's description.
     */
    autoAddFiles: { type: Boolean, default: false },

    /**
     * Request repo fields (inbound upload repositories).
     *
     * NOTE: These fields are referenced by request-link routes and the upload
     * processing pipeline.
     */
    /**
     * Who in the workspace this project exists for (docs/prds/lnkdrp-locked-projects.md, decision 1).
     *
     * `"workspace"` is every member, which is what a project has always been. `"locked"` is a
     * private data room: it exists only for the people holding a `ProjectMembership` row, with no
     * bypass for an owner or an admin, and for everyone else it is absent rather than refused.
     *
     * The word mirrors `Doc.visibility: "workspace" | "project"` so the two settings read as one
     * vocabulary: containment says which listings a document appears in, the lock says which people
     * a project exists for. It is a word and not an `isLocked: boolean` so that a third state (a
     * read-only or an archived room) does not need a second field saying the same kind of thing.
     *
     * Every filter spreads `{ visibility: { $ne: "locked" } }` through
     * `projectVisibilityClause()` in `src/lib/projects/lockScope.ts`, never an equality: rows
     * written before this field existed carry no `visibility` at all.
     */
    visibility: { type: String, trim: true, enum: ["workspace", "locked"], default: "workspace", index: true },
    /** When the room was locked. Null for a project that has never been locked. */
    lockedAt: { type: Date, default: null },
    /** Who locked it. Kept after an unlock so the feed row and the audit question stay answerable. */
    lockedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    isRequest: { type: Boolean, default: false, index: true },
    requestUploadToken: { type: String, trim: true, default: null, index: true },
    /**
     * View-only capability token (secret) for recipients to view documents within
     * a request repo without granting upload access.
     *
     * Public route: `/request-view/:token`
     */
    requestViewToken: { type: String, trim: true, default: null, index: true },
    /**
     * If true, recipients must be authenticated (signed in) to upload documents via the request link.
     *
     * When false (default), recipient uploads are allowed without sign-in (capability token + bot id).
     */
    requestRequireAuthToUpload: { type: Boolean, default: false },

    /**
     * Review agent settings for request repos.
     * - `requestReviewEnabled`: opt-in gate for running the review agent on request uploads.
     * - `requestReviewPrompt`: requester-provided instructions/notes (not the system prompt).
     * - `requestReviewGuideDocId`: optional "Guide" doc (thesis/RFP/JD) attached to the request repo.
     */
    requestReviewEnabled: { type: Boolean, default: false },
    requestReviewPrompt: { type: String, trim: true, default: "" },
    requestReviewGuideDocId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// --- Request repo invariants -------------------------------------------------
// Request repos are stored in the Project collection; the canonical discriminator
// is `isRequest`, and `requestUploadToken` must be present for all request repos.
projectSchema.pre("validate", function () {
  const self = this as unknown as {
    get?: (path: string) => unknown;
    set?: (path: string, value: unknown) => void;
    invalidate?: (path: string, message: string) => void;
    isRequest?: unknown;
    requestUploadToken?: unknown;
  };

  const tokenRaw =
    typeof self.get === "function" ? self.get("requestUploadToken") : (self.requestUploadToken as unknown);
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  const isRequestRaw = typeof self.get === "function" ? self.get("isRequest") : (self.isRequest as unknown);
  const isRequest = Boolean(isRequestRaw) || Boolean(token);

  // If a token exists, this is definitively a request repo.
  if (typeof self.set === "function") self.set("isRequest", isRequest);
  else self.isRequest = isRequest;

  // If marked as a request repo, the token must exist.
  if (isRequest && !token && typeof self.invalidate === "function") {
    self.invalidate("requestUploadToken", "Request repositories must have a requestUploadToken");
  }
});

// Org-aware uniqueness (preferred), among live projects only. A soft-deleted project (an admin
// delete, or a deleted workspace) used to keep its name, so creating one with that name answered
// 409 for a project nobody could see. `isDeleted: false` is an equality, so rows without the field
// escape the index: `db/migration/20260925_0003_projects_live_unique_names.mjs` backfills it and
// rebuilds these two under the same names, and the schema default keeps new rows in.
projectSchema.index(
  { orgId: 1, name: 1 },
  { unique: true, partialFilterExpression: { orgId: { $type: "objectId" }, isDeleted: false } },
);
projectSchema.index(
  { orgId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { orgId: { $type: "objectId" }, isDeleted: false } },
);

// Legacy per-user uniqueness for older records that don't have orgId yet.
projectSchema.index(
  { userId: 1, name: 1 },
  { unique: true, partialFilterExpression: { orgId: { $exists: false } } },
);
projectSchema.index(
  { userId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { orgId: { $exists: false } } },
);

export type Project = InferSchemaType<typeof projectSchema>;

const ExistingProjectModel = mongoose.models.Project as Model<Project> | undefined;

export const ProjectModel: Model<Project> =
  ExistingProjectModel ?? mongoose.model<Project>("Project", projectSchema);

// Dev safety: Next.js hot reload can reuse an already-compiled Mongoose model, so schema additions
// made during development would not take effect until a server restart. Patch newer fields into the
// cached schema (the same pattern `OrgMembership.ts` and `Upload.ts` carry). Locking a room is a
// PATCH-shaped write and strict mode silently DROPS an unknown path on PATCH rather than rejecting
// it, so without this a hot-reloaded dev server would accept the lock request, write nothing, and
// present the bug as an authorization failure: the room stays visible and the switch looks broken.
if (ExistingProjectModel && !ExistingProjectModel.schema.path("visibility")) {
  ExistingProjectModel.schema.add({
    // Must match the schema above, or a hot-reloaded process gives new projects a different default
    // from the one a fresh process gives them.
    visibility: { type: String, trim: true, enum: ["workspace", "locked"], default: "workspace", index: true },
    lockedAt: { type: Date, default: null },
    lockedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  } as any);
}




