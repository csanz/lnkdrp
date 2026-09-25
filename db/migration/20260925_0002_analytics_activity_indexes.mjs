/**
 * Single-field activity indexes for the nightly analytics reconcile.
 *
 * `/api/cron/analytics-reconcile` selects settled rows by a range on `lastViewedAt` (shareviews)
 * and `lastEventAt` (sharevisits) with nothing else in the match. Every index that carries those
 * fields leads with `docId`, `shareId` or `orgId`, so the planner could not use any of them and the
 * job scanned both collections end to end, nightly, inside one 300 s function (code review
 * 2026-09-23, M9). The job now also picks which links to reconcile by `lastViewedAt`, on both
 * shareviews and sharelinks, so the indexes serve both halves.
 *
 * Declared in `ShareView.ts` / `ShareVisit.ts` too, with the same key and name, so autoIndex does
 * not conflict. Non-unique, so it cannot fail on existing data. Safe to re-run.
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, name) {
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
    const existing = indexes.find((i) => i?.name === name);
    if (existing) {
      if (JSON.stringify(existing.key ?? null) === JSON.stringify(key)) return;
      await coll.dropIndex(name);
    }
    await coll.createIndex(key, { name });
  }

  await ensureIndex(db.collection("shareviews"), { lastViewedAt: -1 }, "lastViewedAt_-1");
  await ensureIndex(db.collection("sharevisits"), { lastEventAt: -1 }, "lastEventAt_-1");
  // The links' own stored counter: the other half of "what moved since last night".
  await ensureIndex(db.collection("sharelinks"), { lastViewedAt: -1 }, "lastViewedAt_-1");
  // The admin funnel report reads a few activity types across every workspace for the last N
  // weeks; with only `type_1` the date range was filtered after the scan (pricing plan 4.2).
  await ensureIndex(db.collection("activityevents"), { type: 1, createdDate: -1 }, "type_1_createdDate_-1");
}
