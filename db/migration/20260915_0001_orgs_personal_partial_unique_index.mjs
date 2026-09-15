/**
 * Fix unique index behavior for `orgs.personalForUserId`.
 *
 * Problem (same shape as `20260911_0001_orgs_slug_partial_unique_index`):
 * - The schema defaulted `personalForUserId` to null and team orgs were created with it set to
 *   null explicitly (`POST /api/orgs`).
 * - The unique index was `sparse`, but sparse only skips documents where the field is MISSING; an
 *   explicit null is still indexed, so the SECOND team workspace in a database threw E11000
 *   (surfaced to the user as "An org with that slug already exists").
 *
 * Fix:
 * - Unset `personalForUserId` when it is null (team orgs).
 * - Ensure a partial unique index that only applies to real user ids (personal orgs), so one
 *   personal org per user still holds.
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const wantPartial = options?.partialFilterExpression ?? null;
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e))); // fresh DB: collection may not exist yet
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      const havePartial = existing.partialFilterExpression ?? null;
      const samePartial = JSON.stringify(havePartial) === JSON.stringify(wantPartial);
      const sameUnique = Boolean(existing.unique) === Boolean(options?.unique);
      const sameSparse = Boolean(existing.sparse) === Boolean(options?.sparse);
      if (!sameKey || !samePartial || !sameUnique || !sameSparse) {
        await coll.dropIndex(existing.name);
      } else {
        return; // already correct
      }
    }
    await coll.createIndex(key, options);
  }

  const coll = db.collection("orgs");

  // 1) Clean existing bad defaults (team orgs written with `personalForUserId: null`).
  await coll.updateMany({ personalForUserId: null }, { $unset: { personalForUserId: "" } });

  // 2) Ensure partial unique index (only real user ids participate).
  await ensureIndex(
    coll,
    { personalForUserId: 1 },
    {
      name: "personalForUserId_1",
      unique: true,
      partialFilterExpression: { personalForUserId: { $type: "objectId" } },
    },
  );
}
