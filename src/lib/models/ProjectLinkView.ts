import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * ProjectLinkView — one row per (project link, viewer/device) landing on `/p/:shareId`
 * (docs/prds/lnkdrp-project-links.md decision 6, milestone M2).
 *
 * This answers the question the project page asks and no existing collection can:
 * **who arrived through this link, how often, and which documents did they open?**
 *
 * It is deliberately *not* `ProjectView`/`ProjectClick`. Those are internal telemetry: both require
 * `viewerUserId`, both are written only by the signed-in app page, and `/api/metrics/events`
 * refuses to mint an identity for an anonymous caller — so a recipient physically cannot write one
 * (see docs/METRICS.md, "A share viewer never writes them"). This model uses the recipient identity
 * rule instead — `botIdHash`, the sha256 of the same localStorage `botId` the document viewer
 * already sends — so a project landing is identified exactly the way a document view is, and the
 * two reconcile.
 *
 * What it does **not** hold: per-page or per-document reading time. That stays on
 * `ShareView`/`ShareVisit` under the same `shareId` (the project link's slug), written by
 * `POST /api/share/:shareId/stats` with no new timing code — PRD decision 5. This row is the
 * landing, not the reading.
 *
 * Every field rule below is copied from `ShareView` on purpose, with the reason it exists:
 * `shareLinkId`/`orgId` are `$set` and not `$setOnInsert` (a row written before the link was
 * materialised would otherwise keep a null join handle forever), `lastViewedAt` is written only by
 * the ingest (`updatedDate` is stamped by any maintenance write and cannot mean "someone came"),
 * and `isOwnerPreview` is recorded but never counted.
 */
/**
 * How many tab-session hashes one row keeps. Large enough that a real recipient's sessions are all
 * remembered (a data room visited daily for a year is ~365), small enough that the array can never
 * approach the document size limit.
 */
export const VISIT_ID_HASH_CAP = 500;

const projectLinkViewSchema = new Schema(
  {
    /** The **project link's** public slug — the analytics key, exactly as on `ShareView`. */
    shareId: { type: String, trim: true, index: true, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, required: true },
    /**
     * The `ShareLink` row this landing belongs to. `shareId` stays the key; this is the join
     * handle, and it is `$set` on every ingest so a row can never keep a null one.
     */
    shareLinkId: { type: Schema.Types.ObjectId, ref: "ShareLink", index: true, default: null },
    /**
     * Workspace that owns the project. Denormalized for the same reason as `ShareView.orgId`:
     * workspace-wide questions become one indexed range scan instead of a `$lookup` into `projects`.
     */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", index: true, default: null },
    /** sha256 of the browser's `botId`. The raw identifier is never stored. */
    botIdHash: { type: String, trim: true, index: true, required: true },
    /**
     * The owning side landed on their own project link, not a recipient. Recorded — an owner
     * checking "does the Sequoia link open?" is real, debuggable activity — and excluded from every
     * figure the owner reads, the same bargain `ShareView.isOwnerPreview` strikes.
     */
    isOwnerPreview: { type: Boolean, default: false },

    /** First landing (mirrors `createdDate`, kept explicit so a backfill cannot move it). */
    firstViewedAt: { type: Date, default: null },
    /** Last landing. Only the landing ingest writes it; see the `ShareView.lastViewedAt` note. */
    lastViewedAt: { type: Date, default: null },
    /**
     * Landings on the project page, counted once per tab session (`visitIdHash`), not once per
     * render — a recipient who reloads the list four times looking for a file made one visit.
     */
    visits: { type: Number, default: 0, min: 0 },
    /**
     * Landings keyed by UTC day ("YYYY-MM-DD"), same shape as `downloadsByDay` below.
     *
     * `visits` is **cumulative**, which is why this exists: the metrics window selects rows by
     * *last* activity, so a recipient who landed forty times over six months and came back today
     * was contributing all forty landings to a three-day window. The window figure sums the keys
     * inside it (`landingsPipeline`); `visits` stays as the lifetime count it always was.
     */
    landingsByDay: { type: Map, of: Number, default: {} },
    /**
     * The tab sessions already counted, so a reload inside one cannot count twice.
     *
     * Capped at the most recent {@link VISIT_ID_HASH_CAP} by the ingest (`$push` with `$slice`,
     * never `$addToSet`, which cannot trim): the public landing route is rate-limited per IP but
     * not per device, so a fixed `botId` could append tens of thousands of hashes a day and walk
     * one row into the 16MB BSON ceiling, after which every further landing write fails and the
     * link silently stops counting. The cost of the cap is that a tab session dormant past
     * {@link VISIT_ID_HASH_CAP} newer sessions can be counted a second time — a rounding error
     * against a row that stops recording anything at all.
     */
    visitIdHashes: { type: [String], default: [] },
    /** Documents this viewer opened through this link (`$addToSet`). PRD decision 6. */
    docsOpened: { type: [Schema.Types.ObjectId], ref: "Doc", default: [] },
    /** Downloads taken through this link, across every document in the project. */
    downloads: { type: Number, default: 0, min: 0 },
    /** Downloads keyed by UTC day ("YYYY-MM-DD"), same shape as `ShareView.downloadsByDay`. */
    downloadsByDay: { type: Map, of: Number, default: {} },

    /**
     * Viewer identity (best-effort), field-for-field identical to `ShareView` so the two can be
     * read side by side without a translation layer.
     */
    viewerIp: { type: String, trim: true, default: null },
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, index: true, default: null },
    viewerName: { type: String, trim: true, default: null },
    viewerEmailSnapshot: { type: String, trim: true, lowercase: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

/**
 * One row per viewer per link — the identity rule that makes "people who came through this link" a
 * row count rather than a `distinct`.
 */
projectLinkViewSchema.index({ shareId: 1, botIdHash: 1 }, { unique: true });

// The per-link reads M4 will make: recency, and the range window.
projectLinkViewSchema.index({ shareId: 1, createdDate: -1 });
projectLinkViewSchema.index({ shareId: 1, lastViewedAt: -1 });

// The project rollup across all of its links.
projectLinkViewSchema.index({ projectId: 1, lastViewedAt: -1 });
projectLinkViewSchema.index({ projectId: 1, createdDate: -1 });

// Workspace-level reads (usage, exports, retention sweeps), mirroring `ShareView`.
projectLinkViewSchema.index({ orgId: 1, lastViewedAt: -1 });
projectLinkViewSchema.index({ orgId: 1, createdDate: -1 });

export type ProjectLinkView = InferSchemaType<typeof projectLinkViewSchema>;

export const ProjectLinkViewModel: Model<ProjectLinkView> =
  (mongoose.models.ProjectLinkView as Model<ProjectLinkView> | undefined) ??
  mongoose.model<ProjectLinkView>("ProjectLinkView", projectLinkViewSchema);
