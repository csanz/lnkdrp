/**
 * TagAssignment — one tag put on one document or one project.
 *
 * A single join collection for both kinds, rather than an array on `Doc` and another on `Project`,
 * because the question tags exist to answer spans both: "everything tagged fundraising" is one
 * indexed read here, and it returns the data room *and* the one-pager that lives in no project.
 *
 * A tag on a project does not propagate to its documents (docs/prds/lnkdrp-tags.md, locked
 * 2026-09-18): a project holds documents that are not all about the same theme, and inheritance
 * would make "untag this one document" impossible to express.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/** What a tag can be put on. Kept as a string so a third kind costs a migration, not a new table. */
export const TAG_TARGET_KINDS = ["doc", "project"] as const;
export type TagTargetKind = (typeof TAG_TARGET_KINDS)[number];

const tagAssignmentSchema = new Schema(
  {
    /** Denormalised from the tag so every read here is bounded by workspace without a join. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    tagId: { type: Schema.Types.ObjectId, ref: "Tag", required: true, index: true },
    targetKind: { type: String, enum: TAG_TARGET_KINDS, required: true },
    /** A `Doc._id` or a `Project._id`, per `targetKind`. */
    targetId: { type: Schema.Types.ObjectId, required: true, index: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdDate: { type: Date, default: Date.now },
    updatedDate: { type: Date, default: Date.now },
  },
  { collection: "tagassignments", timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" } },
);

/** Tagging the same thing twice is the same fact, not two: the unique index makes attach idempotent. */
tagAssignmentSchema.index({ tagId: 1, targetKind: 1, targetId: 1 }, { unique: true });
/** "What is tagged X", the tag page's own query, newest first. */
tagAssignmentSchema.index({ orgId: 1, tagId: 1, createdDate: -1 });
/** "What tags does this document carry", for the chip row on a document or project page. */
tagAssignmentSchema.index({ orgId: 1, targetKind: 1, targetId: 1 });

export type TagAssignment = InferSchemaType<typeof tagAssignmentSchema> & { _id: mongoose.Types.ObjectId };

export const TagAssignmentModel: Model<TagAssignment> =
  (mongoose.models.TagAssignment as Model<TagAssignment>) ||
  mongoose.model<TagAssignment>("TagAssignment", tagAssignmentSchema);
