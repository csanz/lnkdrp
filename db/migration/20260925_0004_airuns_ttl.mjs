/**
 * TTL on `airuns`.
 *
 * Every AI run stores the prompts it was sent, and the user prompt is built from the customer's
 * document text. The rows are for debugging and were kept forever (code review 2026-09-23, Low:
 * MCP/AI). The schema now declares a TTL index on `createdDate` (`AI_RUN_RETENTION_DAYS`, default
 * 30); this migration creates the same index, and when one exists under the same name with a
 * different expiry it is updated in place with `collMod`, which is the one thing autoIndex cannot
 * do (Mongo refuses to build an index whose options differ from the existing one's).
 *
 * Safe to re-run. Expiry is a background sweep, so a large backlog drains over minutes.
 */
export async function up({ db }) {
  const days = (() => {
    const raw = Number((process.env.AI_RUN_RETENTION_DAYS ?? "").trim());
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
  })();
  const expireAfterSeconds = days * 24 * 60 * 60;
  const name = "createdDate_ttl";
  const coll = db.collection("airuns");

  const indexes = await coll
    .indexes()
    .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e)));
  const existing = indexes.find((i) => i?.name === name);
  if (!existing) {
    await coll.createIndex({ createdDate: 1 }, { name, expireAfterSeconds });
    return;
  }
  if (JSON.stringify(existing.key ?? null) !== JSON.stringify({ createdDate: 1 })) {
    await coll.dropIndex(name);
    await coll.createIndex({ createdDate: 1 }, { name, expireAfterSeconds });
    return;
  }
  if (existing.expireAfterSeconds !== expireAfterSeconds) {
    await db.command({ collMod: "airuns", index: { name, expireAfterSeconds } });
  }
}
