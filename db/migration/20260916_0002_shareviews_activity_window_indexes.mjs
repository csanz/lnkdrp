/**
 * `shareviews` indexes behind the owner metrics activity window.
 *
 * `activityWindowMatch` (src/lib/analytics/shareViewAggregates.ts) selects the viewers active in a
 * range with `{ $or: [{ lastViewedAt: { $gte } }, { lastViewedAt: null, updatedDate: { $gte } }] }`.
 * The `updatedDate` branch already has `docId_1_updatedDate_-1` / `shareId_1_updatedDate_-1`; the
 * `lastViewedAt` branch had nothing, so every metrics read of a busy document fetch-filtered the
 * whole document's rows. The indexes are declared in `ShareView.ts`, but autoIndex is silent and not
 * awaited, so creating them here means they exist before traffic.
 *
 * Each key and name matches the model exactly, so this does not conflict with what autoIndex builds:
 * - `shareviews.docId_1_lastViewedAt_-1` (ShareView.ts) — document scope.
 * - `shareviews.shareId_1_lastViewedAt_-1` (ShareView.ts) — one link.
 *
 * Non-unique, so it cannot fail on existing data. Safe to re-run and safe where autoIndex already
 * built them: an index that is already present with the same shape is left alone; one with the same
 * name but a different shape is replaced.
 */
export async function up({ db }) {
  const isText = (key) => Object.values(key).some((v) => v === "text");
  const sortedJson = (obj) => JSON.stringify(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));

  // The server stores a text index's key as `{ _fts: "text", _ftsx: 1 }` with the fields in `weights`.
  function sameShape(existing, key, options) {
    if (isText(key)) {
      if (existing.textIndexVersion == null) return false;
      const wantWeights = Object.fromEntries(Object.keys(key).map((k) => [k, options?.weights?.[k] ?? 1]));
      return sortedJson(existing.weights) === sortedJson(wantWeights);
    }
    return (
      JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null) &&
      Boolean(existing.unique) === Boolean(options?.unique) &&
      Boolean(existing.sparse) === Boolean(options?.sparse) &&
      JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(options?.partialFilterExpression ?? null)
    );
  }

  async function ensureIndex(coll, key, options) {
    const name = options.name;
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e))); // fresh DB: collection may not exist yet
    const existing = indexes.find((i) => i?.name === name);
    if (existing) {
      if (sameShape(existing, key, options)) return; // already correct
      await coll.dropIndex(existing.name);
    } else {
      // Same index under another name (built by hand): creating it again would fail with IndexOptionsConflict.
      const equivalent = indexes.find((i) => i?.name !== "_id_" && sameShape(i, key, options));
      if (equivalent) {
        console.log(`  note: ${coll.collectionName} already has ${name} as "${equivalent.name}"; left as is`);
        return;
      }
    }
    await coll.createIndex(key, options);
  }

  const shareviews = db.collection("shareviews");
  await ensureIndex(shareviews, { docId: 1, lastViewedAt: -1 }, { name: "docId_1_lastViewedAt_-1" });
  await ensureIndex(shareviews, { shareId: 1, lastViewedAt: -1 }, { name: "shareId_1_lastViewedAt_-1" });
}
