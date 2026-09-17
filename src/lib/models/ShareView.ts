import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Per-viewer record for a shared doc, keyed by (shareId, botIdHash).
 * Used to dedupe "views" and to count distinct pages viewed.
 *
 * NOTE: botIdHash is a sha256 hash of a client-generated botId stored in localStorage.
 * We store only the hash to avoid persisting the raw identifier.
 */
const shareViewSchema = new Schema(
  {
    shareId: { type: String, trim: true, index: true, required: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },
    /**
     * The `ShareLink` this view belongs to (a document owns many links; see
     * docs/prds/lnkdrp-multi-links.md). `shareId` stays the analytics key; this is the join
     * handle and is null for rows written before the model existed.
     */
    shareLinkId: { type: Schema.Types.ObjectId, ref: "ShareLink", index: true, default: null },
    /**
     * Workspace that owns the document this view belongs to. Denormalized so workspace-level
     * questions ("how did this org's documents do this month") are one indexed range scan instead
     * of a `$lookup` into `docs`. Null on rows written before the field existed until
     * `scripts/sharelinks-analytics-backfill.ts` has run.
     */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },
    botIdHash: { type: String, trim: true, index: true, required: true },
    /**
     * True when the person behind this row is on the *owning* side of the document — its owner, or
     * a member of the workspace that owns it — rather than a recipient the link was sent to.
     *
     * The row is still written. An owner checking their own link is real, debuggable activity
     * ("did the password page work?", "does the Sequoia link open?"), and deleting it would make
     * the absence of a view indistinguishable from a broken link. What it must not do is inflate
     * the numbers the owner reads: a deck opened four times by its author and never by an investor
     * reported "4 views · 1 person", which is the opposite of the truth the page exists to tell.
     *
     * So: recorded here, and filtered out of every owner-facing aggregate by
     * `RECIPIENT_ONLY_MATCH` (src/lib/analytics/shareViewAggregates.ts). Best-effort — it needs a
     * signed-in session on the ingest request, so an owner who opens their own link in a logged-out
     * browser is indistinguishable from a recipient and counts as one.
     */
    isOwnerPreview: { type: Boolean, default: false },
    /**
     * When this viewer last actually read the share — written **only** by the view ingest path
     * (`POST /api/share/:shareId/stats`, `/s/:shareId/pdf`).
     *
     * "Last viewed" used to be `$max: "$updatedDate"`, and Mongoose stamps `updatedDate` on every
     * update query: a maintenance pass (`scripts/sharelinks-analytics-backfill.ts`, the
     * viewer-name backfill the metrics route itself fires in `after()`, any future repair) rewrote
     * the entire column to the instant it ran, so every link in the table read "just now" after an
     * owner reloaded their own metrics page. A field nothing but a view touches cannot do that.
     * Null on rows written before the field existed; they fall back to `updatedDate` and self-heal
     * on that viewer's next visit.
     */
    lastViewedAt: { type: Date, default: null },
    pagesSeen: { type: [Number], default: [] },
    /**
     * Best-effort total time spent viewing this share (milliseconds).
     * Incremented by the client on background/close events.
     */
    timeSpentMs: { type: Number, default: 0, min: 0 },
    /**
     * Best-effort per-page time spent viewing (milliseconds), keyed by page number ("1", "2", ...).
     * Incremented by the client on page changes + periodic flush.
     */
    pageTimeMsByPage: { type: Map, of: Number, default: {} },
    /**
     * Best-effort viewer IP address (from proxy headers like x-forwarded-for).
     * Note: may be a NAT/proxy IP and can change over time for the same viewer.
     */
    viewerIp: { type: String, trim: true, default: null },
    /**
     * Number of times this viewer downloaded the PDF (best-effort).
     * Only incremented when the receiver hits `/s/:shareId/pdf?download=1`.
     */
    downloads: { type: Number, default: 0, min: 0 },
    /**
     * Downloads keyed by UTC day ("YYYY-MM-DD") so we can build a daily series.
     * Example: { "2025-12-24": 2 }
     */
    downloadsByDay: { type: Map, of: Number, default: {} },
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

// Uniquely identify a "viewer" (botId) per shareId so we can count unique views.
shareViewSchema.index({ shareId: 1, botIdHash: 1 }, { unique: true });

// Support admin endpoints and rollups that sort/filter by recency.
shareViewSchema.index({ updatedDate: -1 });
shareViewSchema.index({ docId: 1, updatedDate: -1 });
shareViewSchema.index({ docId: 1, createdDate: -1 });

// Per-link mirrors of the two docId compounds above. Every owner analytics read is scoped either
// to one link (`{ shareId }`) or to the document (`{ docId }`) and then bounded by a date window;
// without these the per-link path planned an IXSCAN on `shareId_1` and fetch-filtered the date.
shareViewSchema.index({ shareId: 1, createdDate: -1 });
shareViewSchema.index({ shareId: 1, updatedDate: -1 });

// The metrics activity window (`activityWindowMatch`) filters on `lastViewedAt` first. Also created
// by db/migration/20260916_0002 so they exist before traffic.
shareViewSchema.index({ docId: 1, lastViewedAt: -1 });
shareViewSchema.index({ shareId: 1, lastViewedAt: -1 });

// Workspace-level reads (usage meter, org exports, retention sweeps).
shareViewSchema.index({ orgId: 1, createdDate: -1 });

// The workspace metrics window: `/api/metrics/workspace` aggregates a whole workspace for a range,
// so it needs the activity window keyed on the workspace the way the document reads have it keyed
// on the document. Also created by db/migration/20260917_0001 so it exists before traffic.
shareViewSchema.index({ orgId: 1, lastViewedAt: -1 });

export type ShareView = InferSchemaType<typeof shareViewSchema>;

export const ShareViewModel: Model<ShareView> =
  (mongoose.models.ShareView as Model<ShareView> | undefined) ??
  mongoose.model<ShareView>("ShareView", shareViewSchema);




