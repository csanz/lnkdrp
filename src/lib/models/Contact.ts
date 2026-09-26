/**
 * Contact model: one row per person a workspace has heard from (docs/prds/lnkdrp-contacts.md).
 *
 * Every place the product already records a person (an introduction on a link, a signed-in view,
 * a download request, a request-inbox upload) writes a row somewhere with a name or an address on
 * it, and none of them can answer "who is this person across everything we shared". This table
 * is that answer: keyed `(orgId, email)`, exactly the key `ShareViewerEmail` uses, so the address
 * is the identity and a person who reads four decks is one row with four documents on it.
 *
 * It is a view that stays warm, not a source of truth. Nothing here is not already stored on a
 * `ShareView`, `ProjectLinkView`, `ShareDownloadRequest` or activity row; the backfill migration
 * (db/migration/20260925_0006_contacts_backfill.mjs) rebuilds it from those, and the four capture
 * sites keep it current through `upsertContact` in `src/lib/contacts/service.ts`.
 *
 * Deliberately not a replacement for `ShareViewerEmail`: that table is the confirmation flow's own
 * record and works; `verifiedAt` is read from it by the shared key at read time and never copied
 * here, so a confirmation cannot be true in one table and false in the other.
 *
 * Nobody types a contact in and nobody edits a name or address (PRD non-goals). The two fields
 * the team owns are `note` here and tags through `TagAssignment` with `targetKind: "contact"`.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** The four moments the product records a person. A visit alone never makes one. */
export const CONTACT_SOURCE_KINDS = ["introduced", "signed_in", "download_request", "request_upload"] as const;
export type ContactSourceKind = (typeof CONTACT_SOURCE_KINDS)[number];

/** Newest sources kept per contact. A daily reader for a year is bounded by this, not by the BSON ceiling. */
export const CONTACT_SOURCES_KEPT = 50;
/** Documents remembered per contact. Same reason as the sources cap. */
export const CONTACT_DOC_IDS_KEPT = 500;
/** The team's one free-text field, in characters. */
export const CONTACT_NOTE_MAX_CHARS = 2000;

const contactSourceSchema = new Schema(
  {
    kind: { type: String, enum: CONTACT_SOURCE_KINDS, required: true },
    /** The link slug they came through, when there was one (a request-inbox upload has none). */
    shareId: { type: String, trim: true, default: null },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", default: null },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const contactNoteSchema = new Schema(
  {
    text: { type: String, default: "", maxlength: CONTACT_NOTE_MAX_CHARS },
    /** Who last wrote it: "warm, per Chris, Tuesday" is what the next reader needs (PRD decision 6). */
    byUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const contactSchema = new Schema(
  {
    /** The workspace that heard from them. Telling one workspace who you are tells only that one. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** The identity. Lowercased at the schema so a lookup never has to remember to fold it. */
    email: { type: String, required: true, trim: true, lowercase: true },
    /** The latest name they gave. */
    name: { type: String, trim: true, default: null },
    /** The first name they gave, kept because the latest may be a correction or a typo. */
    nameFirstGiven: { type: String, trim: true, default: null },
    /**
     * The address's domain, or null for a webmail provider: `gmail.com` is not a company and must
     * never sort, filter or read as one (`WEBMAIL_DOMAINS` in the service).
     */
    domain: { type: String, trim: true, lowercase: true, default: null },
    /** Set when they viewed signed in; their account is then the source of their name. */
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true, index: true },
    /** Where they came from, newest last, capped at `CONTACT_SOURCES_KEPT` by the upsert. */
    sources: { type: [contactSourceSchema], default: [] },
    /** Documents they touched, `$addToSet`, capped at `CONTACT_DOC_IDS_KEPT` by the upsert. */
    docIds: { type: [Schema.Types.ObjectId], ref: "Doc", default: [] },
    projectIds: { type: [Schema.Types.ObjectId], ref: "Project", default: [] },
    /** Captures that were views: a signed-in read or an introduction, once per request. */
    visits: { type: Number, default: 0, min: 0 },
    /** The team's own words about them. Null until someone writes one. */
    note: { type: contactNoteSchema, default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

/** One contact per address per workspace: the identity rule, and what makes the upsert idempotent. */
contactSchema.index({ orgId: 1, email: 1 }, { unique: true });
/** The default listing: newest activity first. */
contactSchema.index({ orgId: 1, lastSeenAt: -1 });
/** "Everyone at sequoiacap.com". */
contactSchema.index({ orgId: 1, domain: 1 });
/** "Everyone who has read the pitch deck". */
contactSchema.index({ orgId: 1, docIds: 1 });
/** "Everyone who came into the data room". */
contactSchema.index({ orgId: 1, projectIds: 1 });
/** The list sorted by name. */
contactSchema.index({ orgId: 1, name: 1 });

export type Contact = InferSchemaType<typeof contactSchema>;

export const ContactModel: Model<Contact> =
  (mongoose.models.Contact as Model<Contact> | undefined) ?? mongoose.model<Contact>("Contact", contactSchema, "contacts");
