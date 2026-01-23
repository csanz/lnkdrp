/**
 * Fix invalid unique index on `docs.replaceUploadToken`.
 *
 * Some environments accidentally have a UNIQUE index named `replaceUploadToken_1`.
 * Since most docs do not have a replace token, that index treats missing/null as the
 * same value and prevents creating new docs:
 *   E11000 ... index: replaceUploadToken_1 dup key: { replaceUploadToken: null }
 *
 * Desired behavior:
 * - `replaceUploadToken` is an optional capability token used only for public "replace upload" links.
 * - Index should be NON-UNIQUE and SPARSE for fast lookup without write failures.
 */
export async function up({ db }) {
  const coll = db.collection("docs");
  const desired = { unique: false, sparse: true };
  const name = "replaceUploadToken_1";

  let indexes = [];
  try {
    indexes = await coll.indexes();
  } catch {
    // ignore
  }

  const existing = indexes.find((i) => i?.name === name) ?? null;
  const shouldDrop =
    Boolean(existing) &&
    // Drop if it's unique (the known-bad case), or if it's non-sparse (also bad for missing values).
    (Boolean(existing.unique) !== desired.unique || Boolean(existing.sparse) !== desired.sparse);

  if (shouldDrop) {
    try {
      await coll.dropIndex(name);
    } catch {
      // ignore; index might have been dropped already
    }
  }

  // Ensure the correct index exists (idempotent when identical).
  await coll.createIndex({ replaceUploadToken: 1 }, { name, sparse: true });
}

