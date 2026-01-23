/**
 * Indexes to keep Teams tab queries snappy at scale.
 *
 * Targets:
 * - `/api/orgs` membership lookup: OrgMembership.find({ userId, isDeleted != true })
 * - `/api/orgs/:orgId/members` membership lookup: OrgMembership.find({ orgId, isDeleted != true })
 * - `/api/org-invites` list: OrgInvite.find({ orgId, isRevoked != true }).sort({ createdDate: -1 }).limit(25)
 *
 * Notes:
 * - We prefer partial indexes for the soft-delete / revocation filters so `$ne:true`
 *   queries remain index-supported without forcing an `$exists` backfill first.
 * - Safe to run multiple times (createIndex is idempotent).
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const wantPartial = options?.partialFilterExpression ?? null;
    const indexes = await coll.indexes();
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      const havePartial = existing.partialFilterExpression ?? null;
      const samePartial = JSON.stringify(havePartial) === JSON.stringify(wantPartial);
      if (!sameKey || !samePartial) {
        await coll.dropIndex(existing.name);
      } else {
        return; // already correct
      }
    }
    await coll.createIndex(key, options);
  }

  // OrgMembership: list memberships by user (org list / workspace switcher / dashboard header)
  const memberships = db.collection("orgmemberships");
  const invites = db.collection("orginvites");

  await ensureIndex(
    memberships,
    { userId: 1 },
    // Mongo partial indexes don't support `$ne` (it becomes `$not: {$eq: ...}`).
    // Model default is `false`, so this keeps the index aligned with the query intent.
    { name: "userId_1", partialFilterExpression: { isDeleted: false } },
  );

  // OrgMembership: list members by org (Teams: members list)
  await ensureIndex(
    memberships,
    { orgId: 1 },
    { name: "orgId_1", partialFilterExpression: { isDeleted: false } },
  );

  // OrgInvite: list recent (non-revoked) invites for an org with a sort by createdDate.
  // This matches the `/api/org-invites` list query and avoids in-memory sorting.
  await ensureIndex(
    invites,
    { orgId: 1, createdDate: -1 },
    // Same story as above: avoid `$ne` in partial indexes.
    { name: "orgId_1_createdDate_-1", partialFilterExpression: { isRevoked: false } },
  );
}


