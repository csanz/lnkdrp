/**
 * Tag model — a workspace label that can be put on documents and projects.
 *
 * A tag is a row, not a string on a document (docs/prds/lnkdrp-tags.md). That is what makes rename
 * one write instead of a sweep over every tagged thing, merge a single operation, and "everything
 * tagged fundraising" an indexed lookup. Membership lives in `TagAssignment`.
 *
 * `slug` is the folded form of `name` (case and accents), unique per workspace: typing
 * "Fundraising" when "fundraising" exists attaches the existing tag instead of creating a twin,
 * which is the whole reason tag lists rot. Display keeps whatever case the person typed.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const tagSchema = new Schema(
  {
    /** Tenancy boundary. A tag never crosses workspaces, and neither do its assignments. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    /** As typed: "Series A", "Fundraising". Shown everywhere; never used for matching. */
    name: { type: String, trim: true, required: true, maxlength: 60 },
    /** Folded form used for uniqueness and lookup (`tagSlug()` in src/lib/tags/slug.ts). */
    slug: { type: String, trim: true, required: true, maxlength: 60 },
    /**
     * A key into the fixed palette (`src/lib/tags/palette.ts`), not a hex value.
     *
     * Assigned on creation from the least-used colour in the workspace, and changeable per tag.
     * Storing the key rather than the colour keeps a palette change (or a theme that needs a
     * different shade in light mode) a one-file edit instead of a data migration.
     */
    color: { type: String, trim: true, required: true, maxlength: 24 },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdDate: { type: Date, default: Date.now },
    updatedDate: { type: Date, default: Date.now },
  },
  { collection: "tags", timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" } },
);

/** One tag per folded name per workspace: this is what makes "fundraising" and "Fundraising" one tag. */
tagSchema.index({ orgId: 1, slug: 1 }, { unique: true });
/** The sidebar and the manage screen both list a workspace's tags alphabetically. */
tagSchema.index({ orgId: 1, name: 1 });

export type Tag = InferSchemaType<typeof tagSchema> & { _id: mongoose.Types.ObjectId };

export const TagModel: Model<Tag> =
  (mongoose.models.Tag as Model<Tag>) || mongoose.model<Tag>("Tag", tagSchema);
