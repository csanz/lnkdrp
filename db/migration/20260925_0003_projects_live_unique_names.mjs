/**
 * Project names and slugs are unique among *live* projects.
 *
 * The unique indexes `orgId_1_name_1` and `orgId_1_slug_1` on `projects` had the partial filter
 * `{ orgId: { $type: "objectId" } }`, so a project an admin soft-deleted (or one in a deleted
 * workspace) still held its name: creating a project with that name answered 409 for a project
 * nobody could see (code review 2026-09-23, Low). The route's own pre-check already ignored
 * deleted rows; the index did not.
 *
 * Two steps, both safe to re-run:
 * 1. Backfill `isDeleted: false` where the field is missing. A partial filter is an equality, so a
 *    row without the field would otherwise escape uniqueness altogether.
 * 2. Recreate both indexes with `isDeleted: false` in the filter. `src/lib/models/Project.ts`
 *    declares the same key, name and filter, so autoIndex agrees with what is here.
 *
 * Live duplicates cannot exist (the old index forbade them), so the rebuild cannot fail on data.
 */
export async function up({ db }) {
  const projects = db.collection("projects");

  await projects.updateMany({ isDeleted: { $exists: false } }, { $set: { isDeleted: false } });

  const wanted = [
    { key: { orgId: 1, name: 1 }, name: "orgId_1_name_1" },
    { key: { orgId: 1, slug: 1 }, name: "orgId_1_slug_1" },
  ];
  const filter = { orgId: { $type: "objectId" }, isDeleted: false };

  const indexes = await projects
    .indexes()
    .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
  for (const w of wanted) {
    const existing = indexes.find((i) => i?.name === w.name);
    if (existing) {
      const same =
        JSON.stringify(existing.key ?? null) === JSON.stringify(w.key) &&
        existing.unique === true &&
        JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(filter);
      if (same) continue;
      await projects.dropIndex(w.name);
    }
    await projects.createIndex(w.key, { name: w.name, unique: true, partialFilterExpression: filter });
  }
}
