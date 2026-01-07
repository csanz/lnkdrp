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
  // OrgMembership: list memberships by user (org list / workspace switcher / dashboard header)
  await db.collection("orgmemberships").createIndex(
    { userId: 1 },
    { partialFilterExpression: { isDeleted: { $ne: true } } },
  );

  // OrgMembership: list members by org (Teams: members list)
  await db.collection("orgmemberships").createIndex(
    { orgId: 1 },
    { partialFilterExpression: { isDeleted: { $ne: true } } },
  );

  // OrgInvite: list recent (non-revoked) invites for an org with a sort by createdDate.
  // This matches the `/api/org-invites` list query and avoids in-memory sorting.
  await db.collection("orginvites").createIndex(
    { orgId: 1, createdDate: -1 },
    { partialFilterExpression: { isRevoked: { $ne: true } } },
  );
}


