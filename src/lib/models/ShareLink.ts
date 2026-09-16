/**
 * ShareLink — one public link to a document. A document owns any number of links
 * (docs/prds/lnkdrp-multi-links.md); each has its own label, audience, settings and analytics
 * (ShareView/ShareVisit are keyed by `shareId`, so per-link stats come for free).
 *
 * The document's original `Doc.shareId` becomes the `isDefault` link; `ensureDefaultLink()` in
 * `src/lib/share/links.ts` materialises that row lazily for documents created before this model,
 * so `/s/:shareId` keeps resolving with no migration day.
 *
 * Password material mirrors the Doc fields (scrypt hash + salt, plus an encrypted copy so the
 * owner can reveal it), so `verifySharePassword` and `shareAuthCookieValue` work unchanged.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const ShareLinkSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", required: true, index: true },
    /** Public slug used in `/s/:shareId`; same generator as `Doc.shareId`. */
    shareId: { type: String, required: true, trim: true, unique: true },
    /** Private to the sender: "Sequoia · Roelof", "Board deck — Q3". Never shown to viewers. */
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** Optional free-text audience note (a name, a firm, an email). Private to the sender. */
    audience: { type: String, default: null, trim: true, maxlength: 120 },
    /** The document's original link; listed first and used by `share_pdf` / legacy PATCH. */
    isDefault: { type: Boolean, default: false, index: true },

    enabled: { type: Boolean, default: true },
    allowDownload: { type: Boolean, default: false },
    allowRevisionHistory: { type: Boolean, default: false },
    /** Refuse the link after this instant (null = never). */
    expiresAt: { type: Date, default: null },

    passwordSalt: { type: String, default: null },
    passwordHash: { type: String, default: null },
    passwordEnc: { type: String, default: null },
    passwordEncIv: { type: String, default: null },
    passwordEncTag: { type: String, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdVia: { type: String, enum: ["web", "api", "mcp", "migration"], default: "web" },
    /** Soft delete: the link stops resolving; analytics rows stay attached to its shareId. */
    archivedAt: { type: Date, default: null },

    lastViewedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },

    createdDate: { type: Date, default: Date.now },
    updatedDate: { type: Date, default: Date.now },
  },
  { collection: "sharelinks", timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" } },
);

ShareLinkSchema.index({ orgId: 1, docId: 1, createdDate: 1 });
/** The Free-plan cap counts enabled, unexpired, unarchived links across the workspace. */
ShareLinkSchema.index({ orgId: 1, enabled: 1, archivedAt: 1, expiresAt: 1 });
/**
 * Full-text search over `label`/`audience` — mt_9ceLy7DqEr: the field a human actually names a
 * link by ("Sequoia", "Inesto / a16z") had no search path at all; the only matches were on the
 * document's title or a link's random public slug. `label` outweighs `audience` (5:1) since it is
 * the name someone actually asks for ("the a16z link"); `audience` is a secondary free-text note.
 *
 * A Mongo text index only ever indexes whole tokens (split on non-alphanumeric boundaries, so
 * "Inesto / a16z" indexes as "inesto" + "a16z"), not substrings — searching "a16z" or "inesto"
 * matches, searching "nest" does not. That trade — indexed, ranked, workspace-wide lookups instead
 * of an unindexed regex scan — is the point: a collection can only carry one text index, so this is
 * it for `sharelinks`.
 */
ShareLinkSchema.index({ label: "text", audience: "text" }, { name: "sharelinks_label_audience_text", weights: { label: 5, audience: 1 } });

export type ShareLink = InferSchemaType<typeof ShareLinkSchema> & { _id: mongoose.Types.ObjectId };

export const ShareLinkModel: Model<ShareLink> =
  (mongoose.models.ShareLink as Model<ShareLink> | undefined) ?? mongoose.model<ShareLink>("ShareLink", ShareLinkSchema);
