import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * ShareVisit model.
 *
 * A "visit" is a best-effort per-tab session for a share viewer, keyed by:
 * - shareId
 * - botIdHash (per-browser/device)
 * - visitIdHash (per-tab; stored in sessionStorage client-side)
 *
 * This complements `ShareView` (which is lifetime/aggregate per viewer/device) with
 * per-visit timing + page sequence data so we can answer:
 * - number of distinct visits
 * - revisits per page (count)
 * - time per page per visit
 * - page sequence (path analysis) within a visit
 */
const shareVisitSchema = new Schema(
  {
    shareId: { type: String, trim: true, index: true, required: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },

    /**
     * The `ShareLink` this visit belongs to (docs/prds/lnkdrp-multi-links.md). `shareId` stays
     * the analytics key; this is the join handle and is null for pre-model rows.
     */
    shareLinkId: { type: Schema.Types.ObjectId, ref: "ShareLink", index: true, default: null },

    /**
     * Workspace that owns the document (denormalized, same reason as `ShareView.orgId`): it makes
     * org-wide analytics an indexed range scan instead of a `$lookup` into `docs`.
     */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },

    /** Viewer identity (best-effort, per browser/device). */
    botIdHash: { type: String, trim: true, index: true, required: true },

    /**
     * The owning side opened the link, not a recipient — see `ShareView.isOwnerPreview`, which
     * carries the full reasoning. Kept in step by the same ingest write, so a session excluded
     * from the view counts is also excluded from the per-visit timeline the owner reads beside them.
     */
    isOwnerPreview: { type: Boolean, default: false },

    /** Per-tab visit/session id (sha256 of a random client-generated string). */
    visitIdHash: { type: String, trim: true, index: true, required: true },

    /** Best-effort time bounds for this visit. */
    startedAt: { type: Date, required: true },
    lastEventAt: { type: Date, required: true },

    /** Best-effort totals for this visit (milliseconds). */
    timeSpentMs: { type: Number, default: 0, min: 0 },

    /** Unique pages seen during this visit. */
    pagesSeen: { type: [Number], default: [] },

    /** Total time spent on each page in this visit ("1" -> ms). */
    pageTimeMsByPage: { type: Map, of: Number, default: {} },

    /** Count of page "segments" (revisits) per page in this visit ("1" -> count). */
    pageVisitCountByPage: { type: Map, of: Number, default: {} },

    /**
     * Page view sequence for this visit (best-effort).
     * We cap the array to keep documents bounded.
     */
    pageEvents: {
      type: [
        {
          pageNumber: { type: Number, required: true, min: 1 },
          enteredAt: { type: Date, required: true },
          leftAt: { type: Date, required: true },
          durationMs: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },

    /**
     * Best-effort viewer IP address (from proxy headers like x-forwarded-for).
     * Note: may be a NAT/proxy IP and can change over time for the same viewer.
     */
    viewerIp: { type: String, trim: true, default: null },

    /**
     * Viewer identity (best-effort):
     * - viewerUserId: present for registered (signed-in) viewers
     * - viewerEmail: present when a viewer provided an email (even if not registered)
     */
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, index: true, default: null },

    /**
     * Denormalized snapshots for fast owner metrics (avoid $lookup into users).
     * These are best-effort and may become stale if a user changes their profile.
     */
    viewerName: { type: String, trim: true, default: null },
    viewerEmailSnapshot: { type: String, trim: true, lowercase: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Uniquely identify a visit per viewer/device per share.
shareVisitSchema.index({ shareId: 1, botIdHash: 1, visitIdHash: 1 }, { unique: true });

// Common read patterns (owner metrics).
shareVisitSchema.index({ docId: 1, lastEventAt: -1 });
shareVisitSchema.index({ docId: 1, viewerUserId: 1, lastEventAt: -1 });
shareVisitSchema.index({ docId: 1, botIdHash: 1, lastEventAt: -1 });

// Per-link mirrors: the visits endpoint now scopes a viewer's timeline to one link (`?shareId=`),
// so the same three reads exist keyed on the link instead of the document.
shareVisitSchema.index({ shareId: 1, lastEventAt: -1 });
shareVisitSchema.index({ shareId: 1, viewerUserId: 1, lastEventAt: -1 });
shareVisitSchema.index({ shareId: 1, botIdHash: 1, lastEventAt: -1 });

// Workspace-level reads.
shareVisitSchema.index({ orgId: 1, createdDate: -1 });

export type ShareVisit = InferSchemaType<typeof shareVisitSchema>;

export const ShareVisitModel: Model<ShareVisit> =
  (mongoose.models.ShareVisit as Model<ShareVisit> | undefined) ??
  mongoose.model<ShareVisit>("ShareVisit", shareVisitSchema);

