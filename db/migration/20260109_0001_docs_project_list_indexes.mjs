/**
 * Add compound indexes to speed up project doc listing queries.
 *
 * Hot path:
 * - `GET /api/projects/:id/docs`
 * - Filter includes `orgId` + `$or: [{ projectId }, { projectIds }]` and sorts by `updatedDate`.
 *
 * These indexes help Mongo efficiently match project membership and satisfy the sort.
 */
export async function up({ db }) {
  const coll = db.collection("docs");

  // For docs that use the canonical multi-project membership list.
  await coll.createIndex(
    { orgId: 1, projectIds: 1, updatedDate: -1, _id: -1 },
    { name: "docs_org_projectIds_updatedDate" },
  );

  // Backward-compat for older docs that only have `projectId`.
  await coll.createIndex(
    { orgId: 1, projectId: 1, updatedDate: -1, _id: -1 },
    { name: "docs_org_projectId_updatedDate" },
  );
}

