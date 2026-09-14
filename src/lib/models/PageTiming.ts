import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Per-session per-page timing record.
 * The client reports enter/leave timestamps; the server stores a normalized duration.
 *
 * NOT share analytics, and it cannot be made into share analytics: there is no `docId`, no
 * `shareId` and no `orgId` here — the document identity only ever appears inside the free-text
 * `path` (`/doc/<id>/…`, `/s/<slug>`), which is not a join key and which nothing parses. Rows for
 * `/s/` routes do exist (the session tracker runs on share pages too) but they are not
 * attributable, and anonymous visitors — i.e. most share recipients — are dropped at ingest
 * because `/api/metrics/events` only attributes an already-existing actor.
 *
 * Share-link analytics lives in `ShareView` / `ShareVisit` / `ShareDownloadRequest` (see
 * docs/METRICS.md). Do not try to reconcile a link's numbers against this collection.
 */
const pageTimingSchema = new Schema(
  {
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    sessionIdHash: { type: String, trim: true, index: true, required: true },
    path: { type: String, trim: true, index: true, required: true },
    referrer: { type: String, trim: true, default: null },
    enteredAt: { type: Date, required: true },
    leftAt: { type: Date, required: true },
    durationMs: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

pageTimingSchema.index({ viewerUserId: 1, createdDate: -1 });
pageTimingSchema.index({ sessionIdHash: 1, createdDate: -1 });
pageTimingSchema.index({ path: 1, createdDate: -1 });

export type PageTiming = InferSchemaType<typeof pageTimingSchema>;

export const PageTimingModel: Model<PageTiming> =
  (mongoose.models.PageTiming as Model<PageTiming> | undefined) ??
  mongoose.model<PageTiming>("PageTiming", pageTimingSchema);


