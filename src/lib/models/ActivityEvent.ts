/**
 * ActivityEvent model.
 *
 * Append-only workspace activity feed: one row per notable write (doc created, upload completed,
 * share settings changed, request submission received, ...). Rows are written best-effort by
 * `recordActivity()` (see `src/lib/activity/log.ts`) after the primary write succeeds and are read
 * by `GET /api/activity` to render the `/activity` page.
 *
 * `title` is denormalized from the doc/project at write time so the feed renders without joins;
 * `agent` records which MCP/agent client performed the action (null for ordinary browsers).
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const activityEventSchema = new Schema(
  {
    /** Organization tenancy boundary (the feed is always scoped by org). */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Acting user (null for capability-token flows such as request-link uploads). */
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** How the actor authenticated. */
    actorKind: { type: String, enum: ["user", "temp", "secret", "api_key", "viewer"], required: true },
    /** Agent/MCP client attribution (`{ client, version }`), or null for a plain browser. */
    agent: {
      type: new Schema(
        {
          client: { type: String, required: true, trim: true },
          version: { type: String, default: null, trim: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Event type, e.g. `doc.created`, `share.updated` (see `ActivityType`). */
    type: { type: String, required: true, index: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },
    /** Denormalized doc/project title for fast rendering. */
    title: { type: String, default: null, trim: true },
    /** Small, type-specific payload (e.g. `{ changed: { shareEnabled: true } }`). */
    meta: { type: Schema.Types.Mixed, default: {} },
    /** Best-effort client IP (first `x-forwarded-for` hop). */
    ip: { type: String, default: null, trim: true },
    createdDate: { type: Date, default: () => new Date() },
  },
  {
    // We manage `createdDate` explicitly; rows are immutable so no `updatedDate`.
    timestamps: false,
    minimize: false,
  },
);

/**
 * The feed's own index, and the `_id` on the end is the load-bearing part.
 *
 * `GET /api/activity` pages with a keyset cursor: `$or: [{createdDate: {$lt: c}}, {createdDate: c,
 * _id: {$lt: id}}]`. With only `{orgId, createdDate}` the first page was index-served and every
 * page after it was not — the `$or` cannot be one range on that index, so Mongo fetched the
 * workspace's whole history and sorted it in memory. Measured on a small dev database:
 * `SORT <- FETCH <- IXSCAN(orgId_1)`, 2395 keys and 2395 documents examined to return 41. It is an
 * infinite-scroll surface fed by every view, download and upload, so the cost grows with the
 * workspace's entire history and the second page is the one that stops working.
 *
 * Carrying `_id` lets both branches of the `$or` be ranges on this index, so it merges them instead
 * of sorting. Measured on a 4,358-row dev database, page two of one workspace:
 *
 *     before   returned=41  keys=2375  docs=2375   SORT <- FETCH <- OR <- IXSCAN
 *     after    returned=41  keys=62    docs=62     LIMIT <- FETCH <- IXSCAN
 *
 * The 38x is not the point. The point is that the first plan is linear in the workspace's history
 * and the second is not: at a hundred thousand rows the old one examines a hundred thousand and the
 * new one still examines sixty-two. It is a superset of the old `{orgId, createdDate}` index by the prefix rule, so it
 * replaces rather than joins it — but `autoIndex` only ever creates. The old
 * `orgId_1_createdDate_-1` has to be dropped by hand; see the index check in DEPLOY.md.
 */
activityEventSchema.index({ orgId: 1, createdDate: -1, _id: -1 });

/**
 * The funnel report (`src/lib/funnel/report.ts`) reads a handful of types across every workspace
 * for the last N weeks. `type_1` alone serves it by scanning every row of those types and
 * filtering the date afterwards, which grows with the life of the deployment; with the date in the
 * index the range is index-served and the cost is the window's rows only.
 */
activityEventSchema.index({ type: 1, createdDate: -1 });
/**
 * The `who=` filter row. `who=me` and `who=team` both narrow on `actorKind` and `userId`, and
 * neither was indexed at all: the same whole-workspace sort as above, but on page one, so it bit
 * sooner for anyone who used the filter.
 *
 * `agent.client: {$exists: true}` (the `who=agents` case) still cannot use an index. Fixing that
 * needs a real boolean on the row and a backfill, which is a change worth making deliberately
 * rather than as a footnote to an index.
 *
 * `actor=` (a contributor's page, `src/lib/people/actorFilter.ts`) narrows on `userId` and pages
 * with the same keyset cursor as the feed, so it is served by the `_id`-carrying index below rather
 * than by `orgId_1_userId_1_createdDate_-1`. `actor=agent:<client>@<owner>` adds `agent.client` as
 * an equality: that stays a residual filter applied after the index scan, which is acceptable
 * because the scan is already narrowed to one member's rows and a member's own volume is the bound.
 */
activityEventSchema.index({ orgId: 1, actorKind: 1, createdDate: -1 });
activityEventSchema.index({ orgId: 1, userId: 1, createdDate: -1 });
/**
 * The per-actor keyset cursor: `{orgId, userId}` equality, then `createdDate`/`_id` as one range.
 *
 * Exactly the reason `{orgId, createdDate, _id}` exists above, one equality deeper. A contributor's
 * page is an infinite-scroll feed like `/activity`, so without `_id` on the end the `$or` that
 * fetches page two cannot be a range on this index and Mongo falls back to sorting that member's
 * whole history in memory, every page, for the life of the workspace. `orgId_1_userId_1_createdDate_-1`
 * is a prefix of this and may be dropped by hand once this one is built; see the index check in
 * DEPLOY.md. Built ahead of traffic by `db/migration/20260925_0007`, because `activityevents` is
 * one of the collections where a silent `autoIndex` build on live data is not good enough.
 */
activityEventSchema.index({ orgId: 1, userId: 1, createdDate: -1, _id: -1 });
activityEventSchema.index({ orgId: 1, type: 1, createdDate: -1 });
activityEventSchema.index({ docId: 1, createdDate: -1 });

export type ActivityEvent = InferSchemaType<typeof activityEventSchema>;

export const ActivityEventModel: Model<ActivityEvent> =
  (mongoose.models.ActivityEvent as Model<ActivityEvent> | undefined) ??
  mongoose.model<ActivityEvent>("ActivityEvent", activityEventSchema, "activityevents");
