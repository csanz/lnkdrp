import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const docReportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    docId: { type: Schema.Types.ObjectId, ref: "Doc", index: true, required: true },
    message: { type: String, trim: true, default: "" },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: false },
    minimize: false,
  },
);

export type DocReport = InferSchemaType<typeof docReportSchema>;

export const DocReportModel: Model<DocReport> =
  (mongoose.models.DocReport as Model<DocReport> | undefined) ??
  mongoose.model<DocReport>("DocReport", docReportSchema);



