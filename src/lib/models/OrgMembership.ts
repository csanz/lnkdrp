/**
 * Organization membership model.
 *
 * A user can belong to multiple orgs; membership is used to authorize org-scoped
 * actions and to list available orgs for the org switcher UI.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const orgMembershipSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, trim: true, required: true, enum: ["owner", "admin", "member", "viewer"], index: true },

    /**
     * Notification preferences (workspace-scoped).
     *
     * Used for doc replacement update emails (daily digest vs immediate vs off).
     */
    docUpdateEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      default: "daily",
      index: true,
    },
    /**
     * Notification preferences (workspace-scoped).
     *
     * Used for "a teammate added a document" emails (daily digest vs immediate vs off).
     *
     * Defaults to `daily` like its siblings. A personal workspace has one member and the sender
     * skips the uploader, so this is inert there and only costs anything in a shared workspace —
     * which is the only place the event means anything.
     */
    docUploadEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      default: "daily",
      index: true,
    },
    /**
     * Notification preferences (workspace-scoped).
     *
     * Used for "repo link request" notification emails (daily digest vs immediate vs off).
     */
    repoLinkRequestEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      default: "daily",
      index: true,
    },
    /**
     * Notification preferences (workspace-scoped).
     *
     * Used for share-view notification emails: someone opened a document in this workspace
     * (daily digest vs immediate vs off). `off` suppresses both immediate and digest view emails.
     *
     * New memberships default to `immediate`, and so does a missing value
     * (`normalizeViewEmailMode`). Knowing that somebody is reading your deck is worth something
     * while they are still reading it; a digest that arrives tomorrow is a report. The noise this
     * used to guard against is handled better elsewhere — a *return* visit only ever goes in the
     * digest, and one tick naming thirty readers sends one email, not thirty.
     *
     * Rows written before this change hold the string "daily" explicitly, whether or not their
     * owner ever chose it, and are left alone: quietly making somebody's inbox louder is not a
     * default change, it is a surprise. New accounts are asked outright on `/welcome`.
     */
    viewEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      default: "immediate",
      index: true,
    },
    // Optional: future expansion for per-user digest scheduling.
    docUpdateDigestTimezone: { type: String, trim: true, default: null },
    docUpdateDigestTimeLocal: { type: String, trim: true, default: null }, // e.g. "17:00"

    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// A user can have only one membership record per org.
orgMembershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });

export type OrgMembership = InferSchemaType<typeof orgMembershipSchema>;

/** Values of `OrgMembership.viewEmailMode`. A missing value on a stored row means "immediate". */
export type ViewEmailMode = "off" | "daily" | "immediate";

const ExistingOrgMembershipModel = mongoose.models.OrgMembership as Model<OrgMembership> | undefined;

export const OrgMembershipModel: Model<OrgMembership> =
  ExistingOrgMembershipModel ?? mongoose.model<OrgMembership>("OrgMembership", orgMembershipSchema);

// Dev safety: Next.js hot reload can reuse an already-compiled Mongoose model, so schema
// additions made during development would not take effect until a server restart. Patch
// newer fields into the cached schema (same pattern as Upload.ts). With strict mode on, a
// missing path would otherwise silently drop `viewEmailMode` on PATCH.
// Same reason as `viewEmailMode` below: a dev server that hot-reloaded holds the model compiled
// before this field existed, and a missing path is silently dropped on PATCH rather than rejected.
if (ExistingOrgMembershipModel && !ExistingOrgMembershipModel.schema.path("docUploadEmailMode")) {
  ExistingOrgMembershipModel.schema.add({
    docUploadEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      // Must match the schema above, or a hot-reloaded process hands new memberships a different
      // default from the one a fresh process gives them.
      default: "daily",
      index: true,
    },
  } as any);
}

if (ExistingOrgMembershipModel && !ExistingOrgMembershipModel.schema.path("viewEmailMode")) {
  ExistingOrgMembershipModel.schema.add({
    viewEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      // Must match the schema above, or a dev server that hot-reloaded would hand new memberships
      // a different default from the one a fresh process gives them.
      default: "immediate",
      index: true,
    },
  } as any);
}
