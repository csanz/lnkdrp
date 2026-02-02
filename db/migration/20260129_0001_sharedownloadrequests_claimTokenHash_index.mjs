/**
 * Fix unique index behavior for `sharedownloadrequests.claimTokenHash`.
 *
 * Problem:
 * - The schema previously defaulted `claimTokenHash` to null.
 * - A unique index on `claimTokenHash` then treated multiple nulls as duplicates (E11000).
 *
 * Fix:
 * - Unset claimTokenHash when it's null.
 * - Ensure a partial unique index that only applies to string tokens.
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
      const sameUnique = Boolean(existing.unique) === Boolean(options?.unique);
      if (!sameKey || !samePartial || !sameUnique) {
        await coll.dropIndex(existing.name);
      } else {
        return; // already correct
      }
    }
    await coll.createIndex(key, options);
  }

  const coll = db.collection("sharedownloadrequests");

  // 1) Clean existing bad defaults.
  await coll.updateMany({ claimTokenHash: null }, { $unset: { claimTokenHash: "" } });

  // 2) Ensure partial unique index (only strings participate).
  await ensureIndex(
    coll,
    { claimTokenHash: 1 },
    {
      name: "claimTokenHash_1",
      unique: true,
      partialFilterExpression: { claimTokenHash: { $type: "string" } },
    },
  );
}

