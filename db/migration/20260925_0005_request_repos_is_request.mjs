/**
 * Persist `isRequest: true` on every project that carries a request upload token.
 *
 * `isRequest` is the canonical discriminator for request repos, but repos created before it
 * existed only had the token. `GET /api/admin/data/requests` used to run this `updateMany` as a
 * backfill on every list (code review 2026-09-23, Admin / cron): an unbounded write inside a read,
 * on every page load of an admin table. The list is read-only now, and the backfill runs here,
 * once. Safe to re-run: a row already marked matches nothing.
 */
export async function up({ db }) {
  const res = await db.collection("projects").updateMany(
    {
      requestUploadToken: { $exists: true, $nin: [null, ""] },
      $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }],
    },
    { $set: { isRequest: true } },
  );
  return { matched: res.matchedCount, modified: res.modifiedCount };
}
