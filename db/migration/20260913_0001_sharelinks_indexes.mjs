/**
 * Indexes for `sharelinks` — one public link to a document (docs/prds/lnkdrp-multi-links.md).
 *
 * Mongoose would create these on first use, but production runs with autoIndex off, and the
 * unique index on `shareId` is what makes `ensureDefaultLink()` safe against a race: two
 * concurrent resolutions of the same legacy document both try to materialise the default link,
 * and the loser catches the duplicate-key error and re-reads the winner's row.
 *
 * Index set:
 * - `shareId` unique — every public slug resolves to exactly one link.
 * - `{ orgId, enabled, archivedAt, expiresAt }` — the Free-plan cap counts active links per
 *   workspace on every link create/enable, so it must not collection-scan.
 * - `{ orgId, docId, createdDate }` — the Links panel lists one document's links.
 * - `{ docId, isDefault }` — `ensureDefaultLink` / `syncDocShareState` look up the default link.
 *
 * Safe to re-run: each index is created only when missing or when its shape changed.
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      const sameUnique = Boolean(existing.unique) === Boolean(options?.unique);
      if (sameKey && sameUnique) return;
      await coll.dropIndex(existing.name);
    }
    await coll.createIndex(key, options);
  }

  const coll = db.collection("sharelinks");

  await ensureIndex(coll, { shareId: 1 }, { name: "shareId_1", unique: true });
  await ensureIndex(coll, { orgId: 1, enabled: 1, archivedAt: 1, expiresAt: 1 }, { name: "orgId_1_enabled_1_archivedAt_1_expiresAt_1" });
  await ensureIndex(coll, { orgId: 1, docId: 1, createdDate: 1 }, { name: "orgId_1_docId_1_createdDate_1" });
  await ensureIndex(coll, { docId: 1, isDefault: 1 }, { name: "docId_1_isDefault_1" });
}
