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

    /** Viewer identity (best-effort, per browser/device). */
    botIdHash: { type: String, trim: true, index: true, required: true },

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

export type ShareVisit = InferSchemaType<typeof shareVisitSchema>;

export const ShareVisitModel: Model<ShareVisit> =
  (mongoose.models.ShareVisit as Model<ShareVisit> | undefined) ??
  mongoose.model<ShareVisit>("ShareVisit", shareVisitSchema);

