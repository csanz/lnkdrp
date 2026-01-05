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
     * Used for "repo link request" notification emails (daily digest vs immediate vs off).
     */
    repoLinkRequestEmailMode: {
      type: String,
      trim: true,
      enum: ["off", "daily", "immediate"],
      default: "daily",
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

export const OrgMembershipModel: Model<OrgMembership> =
  (mongoose.models.OrgMembership as Model<OrgMembership> | undefined) ??
  mongoose.model<OrgMembership>("OrgMembership", orgMembershipSchema);




