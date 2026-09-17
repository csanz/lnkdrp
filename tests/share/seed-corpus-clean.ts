/**
 * Remove a seed corpus. Dry run by default: prints what would be deleted per collection.
 *
 * Run:
 *   EMAIL_TRANSPORT=console npx tsx --env-file=.env.local tests/share/seed-corpus-clean.ts --tag <TAG> [--traffic-only] [--apply]
 *
 * Documents are `docs.find({seedTag})` plus every doc id in the manifest (abandoned ones included).
 * Full cleanup deletes every row keyed by those doc ids, the docs, their Blob files, and revokes any
 * "seed-corpus <TAG>" API key. `--traffic-only` deletes only visits, views and `share.*` activity, so
 * traffic can be generated again on the same documents.
 */
import fs from "node:fs";
import path from "node:path";

import { del, list } from "@vercel/blob";
import mongoose, { Types } from "mongoose";

import { argValue as arg, assertConsoleEmail, assertTag, readManifest, SEED_DIR, writeManifest } from "./seed-corpus/api";
import { connectMongo } from "@/lib/mongodb";
import { revokeApiKey } from "@/lib/agents/apiKeys";
import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";
import { rollupDocMetrics } from "@/lib/metrics/rollupDocMetrics";

assertConsoleEmail();

function log(s = ""): void {
  console.log(s);
}

/** Collections keyed by docId, in delete order; docs go last. */
const BY_DOC = [
  "sharevisits",
  "shareviews",
  "sharedownloadrequests",
  "activityevents",
  "sharelinks",
  "uploads",
  "airuns",
  "docchanges",
  "reviews",
  "starreddocs",
  "creditledgers",
] as const;
const TRAFFIC_ONLY = new Set(["sharevisits", "shareviews", "activityevents"]);

async function blobPaths(docIds: string[]): Promise<string[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const urls: string[] = [];
  for (const id of docIds) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `docs/${id}/`, cursor, limit: 1000 });
      urls.push(...page.blobs.map((b) => b.url));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return urls;
}

async function main(): Promise<void> {
  const tag = assertTag(arg("tag"));
  const apply = process.argv.includes("--apply");
  const trafficOnly = process.argv.includes("--traffic-only");
  const manifest = readManifest(tag);

  await connectMongo();
  const db = mongoose.connection.db!;
  const tagged = await db.collection("docs").find({ seedTag: tag }, { projection: { _id: 1, orgId: 1 } }).toArray();
  const ids = new Set<string>(tagged.map((d) => String(d._id)));
  for (const d of manifest?.docs ?? []) ids.add(d.docId);
  for (const id of manifest?.abandonedDocIds ?? []) ids.add(id);
  const docIds = [...ids].filter((id) => Types.ObjectId.isValid(id));
  const docOids = docIds.map((id) => new Types.ObjectId(id));
  const orgId = manifest?.orgId || (tagged[0]?.orgId ? String(tagged[0].orgId) : null);

  const existing = new Map((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => [c.name.toLowerCase(), c.name]));
  log(`${apply ? "APPLY" : "dry run"}: seed corpus ${tag}${trafficOnly ? " (traffic only)" : ""} · ${docIds.length} documents (${tagged.length} tagged in Mongo)`);

  const plan: Array<{ name: string; filter: Record<string, unknown>; n: number }> = [];
  for (const key of BY_DOC) {
    if (trafficOnly && !TRAFFIC_ONLY.has(key)) continue;
    const name = existing.get(key);
    if (!name) continue;
    const filter: Record<string, unknown> = { docId: { $in: docOids } };
    if (key === "activityevents" && trafficOnly) filter.type = { $regex: /^share\./ };
    if (key === "creditledgers") filter.creditsCharged = { $in: [0, null] };
    plan.push({ name, filter, n: await db.collection(name).countDocuments(filter) });
  }
  if (!trafficOnly) {
    // Using the seed's API key writes `agent.*` feed rows that carry the key name but no docId.
    const filter = { type: { $regex: /^agent\./ }, "meta.name": `seed-corpus ${tag}` };
    plan.push({ name: "activityevents", filter, n: await db.collection("activityevents").countDocuments(filter) });
  }
  if (!trafficOnly) plan.push({ name: "docs", filter: { _id: { $in: docOids } }, n: await db.collection("docs").countDocuments({ _id: { $in: docOids } }) });
  for (const p of plan) log(`  ${p.name.padEnd(24)} ${p.n}`);

  if (!trafficOnly) {
    const charged = existing.get("creditledgers")
      ? await db.collection(existing.get("creditledgers")!).countDocuments({ docId: { $in: docOids }, creditsCharged: { $gt: 0 } })
      : 0;
    if (charged) log(`  note: ${charged} creditledgers rows with creditsCharged > 0 are kept (billing history)`);
  }

  const blobs = trafficOnly ? [] : await blobPaths(docIds);
  if (!trafficOnly) log(`  ${"blob files".padEnd(24)} ${process.env.BLOB_READ_WRITE_TOKEN ? blobs.length : "skipped (no BLOB_READ_WRITE_TOKEN)"}`);
  const keys = trafficOnly
    ? []
    : await db
        .collection("apikeys")
        .find({ name: `seed-corpus ${tag}`, revokedAt: null }, { projection: { _id: 1, orgId: 1 } })
        .toArray();
  if (!trafficOnly) log(`  ${"api keys to revoke".padEnd(24)} ${keys.length}`);

  if (!apply) {
    log();
    log("dry run: nothing deleted. Re-run with --apply to delete.");
    return;
  }

  for (const p of plan) {
    const res = await db.collection(p.name).deleteMany(p.filter);
    log(`  deleted ${String(res.deletedCount).padStart(6)} ${p.name}`);
  }
  if (blobs.length) {
    for (let i = 0; i < blobs.length; i += 100) await del(blobs.slice(i, i + 100));
    log(`  deleted ${String(blobs.length).padStart(6)} blob files`);
  }
  for (const k of keys) await revokeApiKey({ orgId: String(k.orgId), keyId: String(k._id) });
  if (keys.length) log(`  revoked ${keys.length} API keys`);

  if (orgId) {
    const reconciled = await reconcileShareLinkCounters({ orgId });
    log(`  reconciled link counters (${reconciled.linksReconciled} realigned)`);
  }
  // In-process: `npm run metrics:rollup:once` finishes its pass but never exits.
  const rollup = await rollupDocMetrics({});
  log(`  metrics rollup (${rollup.processed} docs)`);

  const progress = path.join(SEED_DIR, tag, "progress.json");
  if (fs.existsSync(progress)) fs.renameSync(progress, path.join(SEED_DIR, tag, `progress.cleared-${Date.now()}.json`));
  if (manifest) {
    if (trafficOnly) delete manifest.traffic;
    else manifest.cleanedAt = new Date().toISOString();
    writeManifest(manifest);
  }
  log();
  log(`Cleanup of ${tag} applied. Tell the notification-cron owner: "Cleanup of ${tag} applied; seeded rows are gone."`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
