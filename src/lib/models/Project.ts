import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const projectSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    name: { type: String, trim: true, required: true },
    slug: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: "" },
    /**
     * If true, the AI is allowed to automatically route newly-uploaded docs
     * into this project based on the project's description.
     */
    autoAddFiles: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// Prevent duplicate project names per user (case-sensitive).
projectSchema.index({ userId: 1, name: 1 }, { unique: true });
// Prevent duplicate slugs per user (used for /project/:slug).
projectSchema.index({ userId: 1, slug: 1 }, { unique: true });

export type Project = InferSchemaType<typeof projectSchema>;

export const ProjectModel: Model<Project> =
  (mongoose.models.Project as Model<Project> | undefined) ??
  mongoose.model<Project>("Project", projectSchema);



