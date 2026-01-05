/**
 * Create indexes for usage aggregates and stats/admin endpoints.
 */
export async function up({ db }) {
  // Usage aggregates collections (new).
  await db.collection("usageaggdailies").createIndex({ workspaceId: 1, day: 1 }, { unique: true });
  await db.collection("usageaggdailies").createIndex({ workspaceId: 1, day: -1 });

  await db.collection("usageaggcycles").createIndex({ workspaceId: 1, cycleKey: 1 }, { unique: true });
  await db.collection("usageaggcycles").createIndex({ workspaceId: 1, cycleStart: -1 });

  // CreditLedger indexes to keep cycle-bounded scans index-supported.
  await db.collection("creditledgers").createIndex({ workspaceId: 1, eventType: 1, status: 1, cycleKey: 1, createdDate: -1 });
  await db.collection("creditledgers").createIndex({ workspaceId: 1, eventType: 1, status: 1, cycleStart: 1, createdDate: -1 });

  // ShareView admin endpoints (recency + per-doc).
  await db.collection("shareviews").createIndex({ updatedDate: -1 });
  await db.collection("shareviews").createIndex({ docId: 1, updatedDate: -1 });
  await db.collection("shareviews").createIndex({ docId: 1, createdDate: -1 });
}


