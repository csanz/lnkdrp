/**
 * Replace the partial `userId_1` / `orgId_1` indexes on `orgmemberships` with plain ones.
 *
 * `20260107_0001_teams_query_indexes.mjs` built both with `partialFilterExpression: { isDeleted: false }`.
 * Every runtime query filters `isDeleted: { $ne: true }` (src/app/api/orgs/route.ts, the members
 * list, `getWorkspaceUsage`, `resolveActor`'s membership checks), and the planner only uses a
 * partial index when the predicate provably implies the filter; `$ne: true` does not (it also
 * matches rows with no field). So `find({ userId })` on memberships, which runs on every app load
 * through `/api/orgs`, was a collection scan. Worse, `src/lib/models/OrgMembership.ts` declares
 * `index: true` on both fields, so autoIndex tried to build plain indexes under the same names and
 * failed with IndexOptionsConflict, silently, on every boot.
 *
 * Plain indexes serve the `$ne` queries (the equality on the leading key is what matters; the
 * soft-delete flag is a fetch filter) and match the schema, so autoIndex stops conflicting. The
 * old migration is left as it was: it has run, and it is idempotent about its own shape, but this
 * one sorts after it and wins on a fresh database too.
 *
 * `orginvites.orgId_1_createdDate_-1` keeps its `{ isRevoked: false }` filter on purpose: the
 * schema declares it that way and `/api/org-invites` was changed to query `isRevoked: false`.
 *
 * Safe to re-run: an index already in the wanted shape is left alone.
 */
export async function up({ db }) {
  async function ensurePlainIndex(coll, key, name) {
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
    const existing = indexes.find((i) => i?.name === name);
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key);
      const plain = !existing.partialFilterExpression && !existing.unique && !existing.sparse;
      if (sameKey && plain) return;
      await coll.dropIndex(name);
    }
    await coll.createIndex(key, { name });
  }

  const memberships = db.collection("orgmemberships");
  await ensurePlainIndex(memberships, { userId: 1 }, "userId_1");
  await ensurePlainIndex(memberships, { orgId: 1 }, "orgId_1");
}
