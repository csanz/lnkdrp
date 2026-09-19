/**
 * One row per address a reader has volunteered to a workspace.
 *
 * Verification is a fact about an *address in a workspace*, not about a view row. A reader who
 * introduces themselves on three links in the same data room confirms their address once, and the
 * answer has to hold for all three — so this is keyed `(orgId, email)` rather than living on
 * `ShareView`, which has one row per link per person and would have to be kept in step forever.
 *
 * Deliberately not on `ShareView`/`ProjectLinkView` for a second reason: those two are the busiest
 * writes in the product and the realtime server watches their identity fields. A confirmation is
 * neither hot nor something an open metrics page needs to be woken for.
 *
 * Nothing in the reading path consults this. Confirming is explicitly not a gate (owner decision,
 * 2026-09-18): the document is already open, and the only thing a confirmation buys is that the
 * sender is told "this address is theirs" rather than "this is what they typed".
 */
import mongoose, { Schema, type InferSchemaType } from "mongoose";

const ShareViewerEmailSchema = new Schema(
  {
    /** The workspace the address was given to. Telling one owner who you are tells only them. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** Lowercased at the schema so a lookup never has to remember to fold it. */
    email: { type: String, required: true, trim: true, lowercase: true },
    /** When they first typed it here. */
    firstIntroducedAt: { type: Date, default: null },
    /** When they clicked the link in the confirmation mail. Null means "claimed, not confirmed". */
    verifiedAt: { type: Date, default: null },
    /**
     * The analytics key that claimed the address, kept for support ("which reader was this?") and
     * so a confirmation can be attributed to the rows it came from. The bare viewer digest, never
     * a project key with its document suffix.
     */
    viewerKey: { type: String, default: null },
    /** The link they were on when they introduced themselves; the first one, not the latest. */
    shareId: { type: String, default: null },
    /** How many confirmation mails we have sent for this address, so a resend can be bounded. */
    verifyEmailsSent: { type: Number, default: 0 },
    lastVerifyEmailAt: { type: Date, default: null },
    createdDate: { type: Date, default: Date.now },
    updatedDate: { type: Date, default: Date.now },
  },
  { collection: "sharevieweremails" },
);

// One row per address per workspace: the upsert on introduce and the read on verify both key on
// exactly this pair.
ShareViewerEmailSchema.index({ orgId: 1, email: 1 }, { unique: true });

export type ShareViewerEmail = InferSchemaType<typeof ShareViewerEmailSchema>;

export const ShareViewerEmailModel =
  (mongoose.models.ShareViewerEmail as mongoose.Model<ShareViewerEmail>) ||
  mongoose.model<ShareViewerEmail>("ShareViewerEmail", ShareViewerEmailSchema);
