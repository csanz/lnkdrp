/**
 * Indexes for ShareVisit (per-visit share viewer sessions).
 *
 * Targets:
 * - Owner metrics per-viewer visit list queries (filter by docId + viewerUserId/botIdHash, sort by lastEventAt)
 * - Uniqueness for visit identity: (shareId, botIdHash, visitIdHash)
 *
 * Safe to run multiple times (createIndex is idempotent).
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const indexes = await coll.indexes();
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      if (sameKey) return;
      await coll.dropIndex(existing.name);
    }
    await coll.createIndex(key, options);
  }

  const sharevisits = db.collection("sharevisits");

  await ensureIndex(sharevisits, { shareId: 1, botIdHash: 1, visitIdHash: 1 }, { name: "shareId_1_botIdHash_1_visitIdHash_1", unique: true });
  await ensureIndex(sharevisits, { docId: 1, lastEventAt: -1 }, { name: "docId_1_lastEventAt_-1" });
  await ensureIndex(sharevisits, { docId: 1, viewerUserId: 1, lastEventAt: -1 }, { name: "docId_1_viewerUserId_1_lastEventAt_-1" });
  await ensureIndex(sharevisits, { docId: 1, botIdHash: 1, lastEventAt: -1 }, { name: "docId_1_botIdHash_1_lastEventAt_-1" });
}

