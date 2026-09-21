/**
 * ShareLink — one public link to a document **or** to a project
 * (docs/prds/lnkdrp-multi-links.md, docs/prds/lnkdrp-project-links.md).
 *
 * A document owns any number of links; so does a project. Each has its own label, audience,
 * settings and analytics (ShareView/ShareVisit are keyed by `shareId`, so per-link stats come for
 * free). One row is a document link (`docId` set, `/s/:shareId`) or a project link (`projectId`
 * set, `/p/:shareId`) and never both — `kind` says which, and the pre-validate hook below enforces
 * the exclusivity rather than trusting every caller to.
 *
 * `kind` is stored rather than derived from `docId != null` on purpose: it is one indexed field
 * every audited query can filter on, it survives a projection that omits `docId`, and it lets the
 * exclusivity invariant be checked in one place. Rows written before project links exist have no
 * `kind` at all, so "document links" is always expressed as `kind: { $ne: "project" }`
 * ({@link DOC_LINK_FILTER}) — never `kind: "doc"`, which would silently drop every legacy row.
 *
 * The document's original `Doc.shareId` becomes the `isDefault` link; `ensureDefaultLink()` in
 * `src/lib/share/links.ts` materialises that row lazily for documents created before this model,
 * so `/s/:shareId` keeps resolving with no migration day. `ensureDefaultProjectLink()` in
 * `src/lib/share/projectLinks.ts` does the same for `Project.shareId` and `/p/:shareId`.
 *
 * Password material mirrors the Doc fields (scrypt hash + salt, plus an encrypted copy so the
 * owner can reveal it), so `verifySharePassword` and `shareAuthCookieValue` work unchanged.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** What a link points at. Stored on every new row; absent on rows written before project links. */
export type ShareLinkKind = "doc" | "project";

/**
 * Filter fragment for "document links only".
 *
 * `$ne: "project"` rather than `kind: "doc"` because every link created before this field existed
 * has no `kind`, and those are all document links. Use it on any query that does not already pin an
 * ObjectId `docId` (a `docId` match excludes project rows on its own, since theirs is null).
 */
export const DOC_LINK_FILTER = { kind: { $ne: "project" } } as const;

/** Filter fragment for "project links only". Every project link is written with `kind` set. */
export const PROJECT_LINK_FILTER = { kind: "project" } as const;

const ShareLinkSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Set on document links, null on project links. Exactly one of `docId`/`projectId` is set. */
    docId: { type: Schema.Types.ObjectId, ref: "Doc", required: false, default: null, index: true },
    /** Set on project links, null on document links. `/p/:shareId` resolves through this. */
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: false, default: null, index: true },
    /** Discriminator; see the module header for why it is stored and not derived. */
    kind: { type: String, enum: ["doc", "project"], default: "doc", index: true },
    /** Public slug used in `/s/:shareId` (doc) or `/p/:shareId` (project); same generator as `Doc.shareId`. */
    shareId: { type: String, required: true, trim: true, unique: true },
    /** Private to the sender: "Sequoia · Roelof", "Board deck — Q3". Never shown to viewers. */
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** Optional free-text audience note (a name, a firm, an email). Private to the sender. */
    audience: { type: String, default: null, trim: true, maxlength: 120 },
    /**
     * The document's (or project's) original link; listed first and used by `share_pdf` / legacy
     * PATCH. Scoped per owner: promoting or clearing a default must filter by `docId` **or**
     * `projectId`, never by `isDefault` alone.
     */
    isDefault: { type: Boolean, default: false, index: true },

    enabled: { type: Boolean, default: true },
    /**
     * True when the document-level share switch turned this link off, as opposed to the sender
     * disabling this one link. Switching the document back on re-enables only these, so a
     * recipient whose link was revoked on its own does not get access back.
     */
    disabledByDocSwitch: { type: Boolean, default: false },
    allowDownload: { type: Boolean, default: false },
    /** Document links only; a project link has no single document whose versions it could list. */
    allowRevisionHistory: { type: Boolean, default: false },
    /** Refuse the link after this instant (null = never). */
    expiresAt: { type: Date, default: null },

    passwordSalt: { type: String, default: null },
    passwordHash: { type: String, default: null },
    passwordEnc: { type: String, default: null },
    passwordEncIv: { type: String, default: null },
    passwordEncTag: { type: String, default: null },

    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /**
     * Who made this link. `default` is the project's or document's own default link, materialised
     * lazily the first time something reads it — which is not a migration, though it used to be
     * recorded as one: a link created seconds after its project reported `createdVia: "migration"`,
     * the marker meant for rows brought forward by the backfill script.
     */
    createdVia: { type: String, enum: ["web", "api", "mcp", "migration", "default"], default: "web" },
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

/**
 * Exactly one owner, and `kind` always agrees with it.
 *
 * Both fields default to null, so a caller that forgets `docId` would otherwise write an orphan row
 * with a live public slug pointing at nothing. Mongoose's `required` cannot express "one of these
 * two", hence the hook — the same shape `Project` uses for its `isRequest` invariant.
 */
ShareLinkSchema.pre("validate", function () {
  const self = this as unknown as {
    get?: (path: string) => unknown;
    set?: (path: string, value: unknown) => void;
    invalidate?: (path: string, message: string) => void;
  };
  const read = (path: string) => (typeof self.get === "function" ? self.get(path) : (self as Record<string, unknown>)[path]);
  const hasDoc = Boolean(read("docId"));
  const hasProject = Boolean(read("projectId"));

  if (hasDoc === hasProject) {
    const message = hasDoc
      ? "A share link cannot belong to both a document and a project"
      : "A share link must belong to a document or a project";
    if (typeof self.invalidate === "function") self.invalidate("docId", message);
    return;
  }

  const kind: ShareLinkKind = hasProject ? "project" : "doc";
  if (typeof self.set === "function") self.set("kind", kind);
  else (self as Record<string, unknown>).kind = kind;
});

ShareLinkSchema.index({ orgId: 1, docId: 1, createdDate: 1 });
/** The project counterpart of the index above: "this project's links, oldest first". */
ShareLinkSchema.index({ orgId: 1, projectId: 1, createdDate: 1 });
/** Listing/counting one project's live links (the per-project cap and the links panel). */
ShareLinkSchema.index({ projectId: 1, archivedAt: 1 });
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
