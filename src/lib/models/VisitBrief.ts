/**
 * VisitBrief model (docs/prds/lnkdrp-visit-briefs.md).
 *
 * One row per **sitting**: a recipient's one-tab reading session on one link. For a document link
 * that is one `ShareVisit`. For a project link it is every `ShareVisit` that shares the same
 * `{shareId, visitIdHash}` — the viewer keys its visit id by the project slug, so one pass through
 * a five-document data room is already one visit id across five rows.
 *
 * The row is the debounce. Nothing in the system knows when a visit is over: the client heartbeats
 * every 30 s while the reader is active, flushes on `pagehide`, and after five idle minutes flushes
 * once more and goes quiet. So every stats ingest upserts this row with
 * `dueAt = lastEventAt + VISIT_QUIET_MS` (`$max`, only ever later), and the `visit-briefs` cron
 * claims rows whose `dueAt` has passed, re-reads the visit, and either pushes `dueAt` out again
 * (the reader came back) or writes the brief. Unique on the sitting, so replays, overlapping runs
 * and restarts all resolve to one brief.
 *
 * Stored rather than only sent: the reader page, the activity feed and the MCP all read the same
 * record, and a brief that cost a credit is worth keeping.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import type { Types } from "mongoose";

export type VisitBriefStatus =
  /** Waiting for the visit to go quiet. `dueAt` says when to look. */
  | "scheduled"
  /** Claimed by a run; `claimedAt` older than the stale window means that run died. */
  | "generating"
  /** The model wrote it; `brief` is set and a credit was charged. */
  | "briefed"
  /** The visit is over and the facts are stored, but no brief was written (see `recapReason`). */
  | "recap"
  /** Nothing to say and nothing sent (owner preview, below the minimum, hard-off). */
  | "skipped"
  /** The model failed every attempt; the recap still went out. */
  | "failed";

export const VISIT_BRIEF_STATUSES: VisitBriefStatus[] = ["scheduled", "generating", "briefed", "recap", "skipped", "failed"];

/**
 * Why a finished visit got a recap instead of a brief, or nothing at all.
 *
 * - `owner_preview`, `below_minimum`: skipped outright, never emailed.
 * - `plan`: Free workspace; the brief narrates per-page detail the plan does not show.
 * - `auto_off`: the workspace switched automatic briefs off (`WorkspaceCreditBalance.autoBriefEnabled`).
 * - `daily_cap`: the workspace's briefs-per-day ceiling, or the Free daily credit brake.
 * - `out_of_credits`: the reservation was refused.
 * - `model_failed`: every model attempt threw.
 */
export type VisitBriefRecapReason =
  | "owner_preview"
  | "below_minimum"
  | "plan"
  | "auto_off"
  | "daily_cap"
  | "out_of_credits"
  | "model_failed";

export const VISIT_BRIEF_RECAP_REASONS: VisitBriefRecapReason[] = [
  "owner_preview",
  "below_minimum",
  "plan",
  "auto_off",
  "daily_cap",
  "out_of_credits",
  "model_failed",
];

/** One document read inside a project-link sitting. Document links have exactly one. */
const visitBriefDocStatsSchema = new Schema(
  {
    docId: { type: Schema.Types.ObjectId, ref: "Doc", required: true },
    /** Title at the time the visit closed; the email re-reads the live one when it can. */
    title: { type: String, trim: true, default: null },
    timeSpentMs: { type: Number, default: 0, min: 0 },
    pagesSeen: { type: [Number], default: [] },
    pageCount: { type: Number, default: null },
    /** "1" -> ms, as on `ShareVisit`. */
    pageTimeMsByPage: { type: Map, of: Number, default: {} },
    /** "1" -> how many separate times the reader landed on that page. */
    pageVisitCountByPage: { type: Map, of: Number, default: {} },
    /** The reading order, trimmed to what a brief can use (see `MAX_STORED_PAGE_EVENTS`). */
    pageEvents: {
      type: [
        {
          pageNumber: { type: Number, required: true, min: 1 },
          enteredAt: { type: Date, required: true },
          leftAt: { type: Date, required: true },
          durationMs: { type: Number, required: true, min: 0 },
          reason: { type: String, default: null },
          toPage: { type: Number, default: null },
        },
      ],
      default: [],
    },
    /** Downloads recorded on this reader's `ShareView` during the sitting (best-effort, by day). */
    downloads: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/** What the same reader did on this link before this sitting, for the brief's "return" context. */
const visitBriefPreviousSchema = new Schema(
  {
    /** Visits by this reader on this link before this one (0 = first time). */
    priorVisits: { type: Number, default: 0, min: 0 },
    lastVisitStartedAt: { type: Date, default: null },
    lastVisitTimeSpentMs: { type: Number, default: null },
    /** Page numbers the last visit spent longest on, up to three. */
    lastVisitTopPages: { type: [Number], default: [] },
  },
  { _id: false },
);

const visitBriefOutputSchema = new Schema(
  {
    /** ≤ 12 words; the immediate email's subject. */
    headline: { type: String, trim: true, required: true },
    /** ≤ 80 words. */
    body: { type: String, trim: true, required: true },
    /** What caught their attention: topics on the pages they held or returned to, ≤ 3. */
    interests: { type: [String], default: [] },
    /** ≤ 4 short facts. */
    highlights: { type: [String], default: [] },
    /** One suggested next step, when the model has one worth giving. */
    followUp: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: null },
    tokensIn: { type: Number, default: null },
    tokensOut: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
  },
  { _id: false },
);

const visitBriefSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Set on a document-link sitting; null on a project-link sitting (whose docs are in `stats.docs`). */
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null, index: true },
    /** Set on a project-link sitting. */
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null, index: true },
    shareLinkId: { type: Schema.Types.ObjectId, ref: "ShareLink", default: null },
    /** The link slug, as on every analytics row. */
    shareId: { type: String, trim: true, required: true },
    /** Per-tab visit id (sha256), shared across every document of a data-room sitting. */
    visitIdHash: { type: String, trim: true, required: true },
    /**
     * The PERSON: the bare device digest, never the `<digest>.<docId>` composite a project link
     * writes on its analytics rows (`splitProjectViewerKey`). The document lives in its own field.
     */
    botIdHash: { type: String, trim: true, required: true, index: true },
    isOwnerPreview: { type: Boolean, default: false },

    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    viewerName: { type: String, trim: true, default: null },
    viewerEmail: { type: String, trim: true, lowercase: true, default: null },

    /** Copied from the visit at claim time; `lastEventAt` is `$max`-ed on every ingest before that. */
    startedAt: { type: Date, required: true },
    lastEventAt: { type: Date, required: true },
    /** `lastEventAt + VISIT_QUIET_MS`, `$max` on every ingest so it only ever moves later. */
    dueAt: { type: Date, required: true },

    status: { type: String, trim: true, enum: VISIT_BRIEF_STATUSES, required: true, default: "scheduled" },
    recapReason: { type: String, trim: true, enum: [...VISIT_BRIEF_RECAP_REASONS, null], default: null },
    /** How many times a run claimed this row and the model call failed. */
    attempts: { type: Number, default: 0, min: 0 },
    claimedAt: { type: Date, default: null },
    claimToken: { type: String, trim: true, default: null },
    lastError: { type: String, trim: true, default: null },
    /** When the visit was judged over and the facts were frozen. */
    closedAt: { type: Date, default: null },

    stats: {
      type: new Schema(
        {
          timeSpentMs: { type: Number, default: 0, min: 0 },
          /** Distinct pages across the sitting (per document on a data room; summed here). */
          pagesSeen: { type: Number, default: 0, min: 0 },
          /** Total pages of the document(s) read, when known. */
          pageCount: { type: Number, default: null },
          downloads: { type: Number, default: 0, min: 0 },
          /** 1 = this reader's first sitting on this link. */
          visitNumber: { type: Number, default: 1, min: 1 },
          docs: { type: [visitBriefDocStatsSchema], default: [] },
          previous: { type: visitBriefPreviousSchema, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    brief: { type: visitBriefOutputSchema, default: null },
    /** The credit ledger row the brief was charged to. */
    ledgerId: { type: Schema.Types.ObjectId, ref: "CreditLedger", default: null },
    aiRunId: { type: Schema.Types.ObjectId, ref: "AiRun", default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// The sitting. One row, whatever replays the ingest and however many documents a data room has.
visitBriefSchema.index({ shareId: 1, visitIdHash: 1 }, { unique: true });

// The claim: `{status: "scheduled", dueAt: {$lte: now}}`.
visitBriefSchema.index({ status: 1, dueAt: 1 });

// Stale-claim recovery: rows left `generating` by a run that died mid-model-call.
visitBriefSchema.index({ status: 1, claimedAt: 1 });

// The reader page: one person's sittings on one document or one data room, newest first.
visitBriefSchema.index({ orgId: 1, docId: 1, botIdHash: 1, startedAt: -1 });
visitBriefSchema.index({ orgId: 1, projectId: 1, botIdHash: 1, startedAt: -1 });

// The per-workspace daily ceiling: briefs written today.
visitBriefSchema.index({ orgId: 1, status: 1, closedAt: -1 });

export type VisitBrief = InferSchemaType<typeof visitBriefSchema> & {
  orgId: Types.ObjectId;
  status: VisitBriefStatus;
  recapReason: VisitBriefRecapReason | null;
};

const ExistingVisitBriefModel = mongoose.models.VisitBrief as Model<VisitBrief> | undefined;

export const VisitBriefModel: Model<VisitBrief> =
  ExistingVisitBriefModel ?? mongoose.model<VisitBrief>("VisitBrief", visitBriefSchema);
