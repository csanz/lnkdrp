/**
 * The per-actor keyset index on `activityevents`, built before traffic reaches it.
 *
 * The contributor pages (`/people/:userId`, `/agents/:client/:ownerUserId`) page one member's rows
 * with the feed's own cursor: `{orgId, userId}` equality, then `$or: [{createdDate: {$lt: c}},
 * {createdDate: c, _id: {$lt: id}}]`. The existing `orgId_1_userId_1_createdDate_-1` serves the
 * first page and nothing after it, because that `$or` cannot be a single range without `_id` in the
 * key, and the fallback is an in-memory sort of the member's whole history on every page.
 *
 * It is declared on the schema too (`src/lib/models/ActivityEvent.ts`), with the same key, so
 * `autoIndex` leaves it alone. It is here as well because `activityevents` is the busiest
 * collection in the product and DEPLOY.md's rule for those is explicit: a build kicked off by the
 * first cold function after a deploy happens on live data and fails silently, so the index a new
 * page depends on goes in a migration where a failure stops the runner in front of someone.
 *
 * `orgId_1_userId_1_createdDate_-1` becomes a prefix of this one and does nothing it does not do.
 * It is NOT dropped here: dropping an index the currently deployed functions may still be planning
 * against, from a migration that runs before the deploy, is how you turn a performance change into
 * an outage. It comes off by hand afterwards, beside the other hand-drop in the index check.
 *
 * Non-unique, so it cannot fail on existing data. Safe to re-run.
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, name) {
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
    const existing = indexes.find((i) => i?.name === name);
    if (existing) {
      if (JSON.stringify(existing.key ?? null) === JSON.stringify(key)) return;
      await coll.dropIndex(name);
    }
    await coll.createIndex(key, { name });
  }

  await ensureIndex(
    db.collection("activityevents"),
    { orgId: 1, userId: 1, createdDate: -1, _id: -1 },
    "orgId_1_userId_1_createdDate_-1__id_-1",
  );
}
