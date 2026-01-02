import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Records a navigation click that originated from inside a project page.
 */
const projectClickSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, required: true },
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    sessionIdHash: { type: String, trim: true, index: true, required: true },
    fromPath: { type: String, trim: true, default: "" },
    toPath: { type: String, trim: true, required: true },
    toDocId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

projectClickSchema.index({ projectId: 1, createdDate: -1 });
projectClickSchema.index({ viewerUserId: 1, createdDate: -1 });

export type ProjectClick = InferSchemaType<typeof projectClickSchema>;

export const ProjectClickModel: Model<ProjectClick> =
  (mongoose.models.ProjectClick as Model<ProjectClick> | undefined) ??
  mongoose.model<ProjectClick>("ProjectClick", projectClickSchema);


