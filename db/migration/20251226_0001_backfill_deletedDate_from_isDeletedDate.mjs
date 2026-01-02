/**
 * Backfill `deletedDate` from legacy `isDeletedDate` for docs/uploads.
 *
 * This is idempotent:
 * - Only sets deletedDate when it is missing/null and isDeletedDate is present.
 * - Does not remove the legacy field.
 */
export async function up({ db }) {
  // docs
  await db.collection("docs").updateMany(
    { deletedDate: { $in: [null, undefined] }, isDeletedDate: { $type: "date" } },
    [{ $set: { deletedDate: "$isDeletedDate" } }],
  );

  // uploads
  await db.collection("uploads").updateMany(
    { deletedDate: { $in: [null, undefined] }, isDeletedDate: { $type: "date" } },
    [{ $set: { deletedDate: "$isDeletedDate" } }],
  );
}




