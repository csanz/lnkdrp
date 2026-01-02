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

// Org-aware uniqueness (preferred).
projectSchema.index(
  { orgId: 1, name: 1 },
  { unique: true, partialFilterExpression: { orgId: { $type: "objectId" } } },
);
projectSchema.index(
  { orgId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { orgId: { $type: "objectId" } } },
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

export const ProjectModel: Model<Project> =
  (mongoose.models.Project as Model<Project> | undefined) ??
  mongoose.model<Project>("Project", projectSchema);




