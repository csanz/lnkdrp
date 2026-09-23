/**
 * Doc report model — **legacy**. Nothing writes this collection any more.
 *
 * It backed a "Report" item in the owner's document menu: a modal, a message, and a POST to
 * `/api/docs/:docId/report`. The route only ever accepted a document in the caller's *own*
 * workspace, so it was never abuse reporting — it was an owner telling us something was wrong
 * with their own file. The half that was never built is the reading half: no admin page, no
 * email, no digest, nothing queried it. The menu item was switched off behind a
 * `SHOW_REPORT = false` const, which left a live endpoint feeding a collection nobody read.
 *
 * Removed on 2026-09-23, UI and route together. The model stays so that `purge.ts` and
 * `scripts/orphan-data-report.ts` can still remove rows written before then when an account is
 * deleted; delete it once the collection is empty in production.
 */
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




