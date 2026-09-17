/**
 * The indexes behind the workspace metrics window, on `shareviews` and `sharevisits`.
 *
 * `GET /api/metrics/workspace` (src/lib/analytics/workspace/query.ts) aggregates a whole workspace
 * for a range: `{ orgId, docId: { $in: <live docs> }, isOwnerPreview: { $ne: true }, ...activityWindowMatch(start) }`.
 * Without a window index keyed on `orgId` the planner falls back to the per-document compounds
 * (`docId_1_lastViewedAt_-1`, or plain `docId_1` for the downloads pipeline, which examined every
 * row of every live document — 596 docs for 51 downloads on the dev corpus). Both are bounded by
 * the workspace, so neither is the dashboard's global scan, but both grow with a workspace's whole
 * history rather than with the window it is asking about.
 *
 * Key and name match the declaration in `src/lib/models/ShareView.ts` exactly, so this does not
 * conflict with what autoIndex builds (autoIndex is silent and not awaited, which is why the index
 * is created here as well):
 * - `shareviews.orgId_1_lastViewedAt_-1` — workspace scope, bounded by last activity;
 * - `sharevisits.orgId_1_lastEventAt_-1` — the same for opens and reading time, which are range
 *   figures and therefore come from visit rows, never from the lifetime counters on `shareviews`.
 *
 * It covers both branches of `activityWindowMatch`: the `lastViewedAt: null` branch is an equality
 * on the same key, with `updatedDate` left as a fetch filter.
 *
 * Non-unique, so it cannot fail on existing data. Safe to re-run and safe where autoIndex already
 * built it: an index that is already present with the same shape is left alone; one with the same
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
  await ensureIndex(shareviews, { orgId: 1, lastViewedAt: -1 }, { name: "orgId_1_lastViewedAt_-1" });

  const sharevisits = db.collection("sharevisits");
  await ensureIndex(sharevisits, { orgId: 1, lastEventAt: -1 }, { name: "orgId_1_lastEventAt_-1" });
}
