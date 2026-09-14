/**
 * Repair `DocChange.fromUploadId` on version-change rows.
 *
 * Until 2026-09-13 the processing job recorded the doc's current upload as `fromUploadId`, but the
 * upload route points the doc at the new upload before processing runs, so rows referenced the new
 * version twice. This sets `fromUploadId` to the upload whose version is `fromVersion`.
 *
 * Usage:
 * - Dry run (default):  tsx --env-file=.env.local scripts/docchange-from-upload-repair.ts
 * - Apply:              tsx --env-file=.env.local scripts/docchange-from-upload-repair.ts --apply
 */
import { connectMongo } from "@/lib/mongodb";
import { DocChangeModel } from "@/lib/models/DocChange";
import { UploadModel } from "@/lib/models/Upload";

async function main() {
  const apply = process.argv.includes("--apply");
  await connectMongo();
  const rows = (await DocChangeModel.find({ $expr: { $eq: ["$fromUploadId", "$toUploadId"] } })
    .select({ _id: 1, docId: 1, fromVersion: 1 })
    .lean()) as Array<{ _id: unknown; docId: unknown; fromVersion?: number | null }>;

  let fixed = 0;
  let unresolved = 0;
  for (const row of rows) {
    const fromVersion = Number(row.fromVersion);
    const prev = Number.isFinite(fromVersion)
      ? await UploadModel.findOne({ docId: row.docId, version: fromVersion }).select({ _id: 1 }).lean()
      : null;
    if (!prev) {
      unresolved += 1;
      continue;
    }
    fixed += 1;
    if (apply) await DocChangeModel.updateOne({ _id: row._id }, { $set: { fromUploadId: prev._id } });
  }
  console.log(`[docchange-repair] rows ${rows.length}; fixed ${fixed}; no upload for fromVersion ${unresolved}; ${apply ? "applied" : "dry run (pass --apply)"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
