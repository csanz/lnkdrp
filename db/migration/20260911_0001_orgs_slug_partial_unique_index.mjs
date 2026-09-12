/**
 * Fix unique index behavior for `orgs.slug`.
 *
 * Problem:
 * - The schema previously defaulted `slug` to null and personal orgs were created with `slug: null`.
 * - The unique index on `slug` was `sparse`, but sparse only skips documents where the field is
 *   MISSING; an explicit null is still indexed, so the second personal org threw E11000.
 *
 * Fix:
 * - Unset slug when it's null (personal orgs).
 * - Ensure a partial unique index that only applies to string slugs (team orgs).
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const wantPartial = options?.partialFilterExpression ?? null;
    const indexes = await coll.indexes().catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e))); // fresh DB: collection may not exist yet
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      const havePartial = existing.partialFilterExpression ?? null;
      const samePartial = JSON.stringify(havePartial) === JSON.stringify(wantPartial);
      const sameUnique = Boolean(existing.unique) === Boolean(options?.unique);
      if (!sameKey || !samePartial || !sameUnique) {
        await coll.dropIndex(existing.name);
      } else {
        return; // already correct
      }
    }
    await coll.createIndex(key, options);
  }

  const coll = db.collection("orgs");

  // 1) Clean existing bad defaults (personal orgs written with `slug: null`).
  await coll.updateMany({ slug: null }, { $unset: { slug: "" } });

  // 2) Ensure partial unique index (only strings participate).
  await ensureIndex(
    coll,
    { slug: 1 },
    {
      name: "slug_1",
      unique: true,
      partialFilterExpression: { slug: { $type: "string" } },
    },
  );
}
