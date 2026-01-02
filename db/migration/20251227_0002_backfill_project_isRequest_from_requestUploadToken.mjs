/**
 * Backfill request-repo fields on `projects`.
 *
 * This is idempotent:
 * - Marks `isRequest=true` when `requestUploadToken` exists.
 * - Ensures `requestReviewEnabled` and `requestReviewPrompt` have safe defaults when missing.
 */
export async function up({ db }) {
  await db.collection("projects").updateMany(
    {
      requestUploadToken: { $type: "string" },
      $or: [{ isRequest: { $in: [null, undefined, false] } }, { isRequest: { $exists: false } }],
    },
    { $set: { isRequest: true } },
  );

  await db.collection("projects").updateMany(
    {
      requestUploadToken: { $type: "string" },
      $or: [
        { requestReviewEnabled: { $exists: false } },
        { requestReviewEnabled: { $in: [null, undefined] } },
      ],
    },
    { $set: { requestReviewEnabled: false } },
  );

  await db.collection("projects").updateMany(
    {
      requestUploadToken: { $type: "string" },
      $or: [
        { requestReviewPrompt: { $exists: false } },
        { requestReviewPrompt: { $in: [null, undefined] } },
      ],
    },
    { $set: { requestReviewPrompt: "" } },
  );
}




