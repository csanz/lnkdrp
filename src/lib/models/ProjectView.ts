import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * A "project view" is the first time a given (userId, sessionId) visits a project.
 * We store sessionId as a server-hashed identifier to avoid persisting raw client IDs.
 */
const projectViewSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true, required: true },
    viewerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    sessionIdHash: { type: String, trim: true, index: true, required: true },
    path: { type: String, trim: true, default: "" },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Dedupe to "one view per session per user per project".
projectViewSchema.index({ projectId: 1, viewerUserId: 1, sessionIdHash: 1 }, { unique: true });

export type ProjectView = InferSchemaType<typeof projectViewSchema>;

export const ProjectViewModel: Model<ProjectView> =
  (mongoose.models.ProjectView as Model<ProjectView> | undefined) ??
  mongoose.model<ProjectView>("ProjectView", projectViewSchema);




