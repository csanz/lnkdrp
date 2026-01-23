/**
 * Indexes to keep project listing queries snappy at scale.
 *
 * Targets:
 * - `/api/projects` list: Project.find({ orgId, isDeleted != true, ... }).sort({ updatedDate: -1, _id: -1 })
 * - Legacy personal projects: Project.find({ userId, orgId missing }).sort({ updatedDate: -1, _id: -1 })
 *
 * Notes:
 * - Safe to run multiple times (createIndex is idempotent).
 * - The API query uses `$or` (orgId or legacy userId), so we add an index for each branch.
 * - Some Mongo-compatible backends (and older Mongo versions) do not support `$exists: false`
 *   in `partialFilterExpression` (it is treated as `$not: { $exists: true }`).
 *   To keep this migration portable, we create a non-partial index for the legacy branch.
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

  const projects = db.collection("projects");

  // Preferred org-scoped listing (most workspaces).
  await ensureIndex(projects, { orgId: 1, updatedDate: -1, _id: -1 }, { name: "orgId_1_updatedDate_-1__id_-1" });

  // Legacy personal projects listing for older records missing orgId (personal org compatibility).
  await ensureIndex(
    projects,
    { userId: 1, updatedDate: -1, _id: -1 },
    // Note: we intentionally avoid a partial filter here for portability.
    { name: "userId_1_updatedDate_-1__id_-1" },
  );
}

