/**
 * Create indexes for org invites.
 *
 * Why:
 * - Org invites use a hashed token (`tokenHash`) for lookup and must be unique.
 * - We frequently query by orgId and revocation/expiry state.
 *
 * Notes:
 * - This migration is safe to run multiple times (createIndex is idempotent).
 * - TTL is NOT enabled here; invites are treated as expired by application logic.
 */
export async function up({ db }) {
  const col = db.collection("orginvites");

  // Primary lookup: sha256(token)
  await col.createIndex({ tokenHash: 1 }, { unique: true });

  // Common filters: org listing/cleanup
  await col.createIndex({ orgId: 1, isRevoked: 1, expiresAt: 1 });

  // Audit/ops helpers
  await col.createIndex({ createdByUserId: 1, createdDate: -1 });
  await col.createIndex({ redeemedByUserId: 1, redeemedAt: -1 });
}



