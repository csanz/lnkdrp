/**
 * Create the seed corpus in the Pro dev workspace: 50 documents (generated PDFs, agent-written
 * summaries so no credits are spent) and 5-10 labelled share links each, through the public API with
 * a short-lived API key. Tagged for cleanup (`docs.seedTag`, `sharelinks.seedTag`) and idempotent.
 *
 * Run:
 *   EMAIL_TRANSPORT=console npx tsx --env-file=.env.local tests/share/seed-corpus.ts --tag <TAG> [--count 50] [--concurrency 3] [--dry-run]
 *
 * Never uploads into a document that already has an upload (a replacement upload creates DocChange
 * rows the notification cron emails about, and spends compare credits): a failed first upload
 * abandons that document and the slug is retried on a new one.
 */
import path from "node:path";

import mongoose, { Types } from "mongoose";

import {
  argValue as arg,
  assertConsoleEmail,
  assertTag,
  manifestPath,
  readManifest,
  SeedApi,
  waitForServer,
  writeManifest,
  type Manifest,
  type ManifestDoc,
} from "./seed-corpus/api";
import { DOC_SPECS, type DocSpec } from "./seed-corpus/content";
import { ensureSpecPdf } from "./seed-corpus/pdf";
import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";

assertConsoleEmail();

const DEFAULT_EMAIL = "chrissanz@gmail.com";
const DEFAULT_ORG_ID = "6aa4a3a4b0b9b3a1a769660a";

function log(s = ""): void {
  console.log(s);
}

function selectSpecs(): DocSpec[] {
  const only = arg("only");
  if (only) {
    const spec = DOC_SPECS.find((s) => s.slug === only);
    if (!spec) throw new Error(`no spec with slug ${only}`);
    return [spec];
  }
  const count = Math.max(1, Math.min(DOC_SPECS.length, Number(arg("count") ?? DOC_SPECS.length)));
  return DOC_SPECS.slice(0, count);
}

function printPlan(tag: string, specs: DocSpec[]): void {
  log(`seed corpus ${tag}: ${specs.length} documents, ${specs.reduce((a, s) => a + s.pages.length, 0)} pages, ${specs.reduce((a, s) => a + s.links.length, 0)} labelled links`);
  for (const s of specs) {
    log(`  ${s.slug.padEnd(44)} ${s.type.padEnd(20)} ${String(s.pages.length).padStart(2)}p  ${s.title}`);
    log(`    links: ${s.links.map((l) => `${l.label}${l.allowDownload ? " (download)" : ""}`).join(" · ")}`);
  }
}

async function main(): Promise<void> {
  const tag = assertTag(arg("tag"));
  const dryRun = process.argv.includes("--dry-run");
  const concurrency = Math.max(1, Math.min(6, Number(arg("concurrency") ?? 3)));
  const specs = selectSpecs();
  const email = arg("email") ?? DEFAULT_EMAIL;
  const orgId = arg("org") ?? DEFAULT_ORG_ID;

  printPlan(tag, specs);
  if (dryRun) {
    log();
    log("dry run: no API key, no documents, no links, no files written.");
    return;
  }

  await waitForServer();
  await connectMongo();
  const db = mongoose.connection.db!;
  const user = await db.collection("users").findOne({ email }, { projection: { _id: 1 } });
  if (!user) throw new Error(`no user ${email}`);
  const userId = String(user._id);
  const member = await db
    .collection("orgmemberships")
    .findOne({ orgId: new Types.ObjectId(orgId), userId: user._id, isDeleted: { $ne: true } }, { projection: { role: 1 } });
  if (!member) throw new Error(`${email} is not a member of org ${orgId}`);

  const manifest: Manifest = readManifest(tag) ?? {
    tag,
    orgId,
    userId,
    apiKeyId: null,
    count: specs.length,
    createdAt: new Date().toISOString(),
    docs: [],
    abandonedDocIds: [],
  };
  manifest.count = Math.max(manifest.count, specs.length);

  const created = await createApiKey({ orgId, userId, name: `seed-corpus ${tag}`, scopes: ["read", "write"] });
  manifest.apiKeyId = created.key.id;
  writeManifest(manifest);
  const api = new SeedApi(created.plaintext);
  const failures: string[] = [];

  try {
    const who = await api.whoami();
    if (who.body.orgId !== orgId) throw new Error(`API key resolves to org ${who.body.orgId}, expected ${orgId}`);
    if (who.body.plan && who.body.plan !== "pro") throw new Error(`workspace plan is ${who.body.plan}; the seed expects Pro (never touch the subscription)`);

    const queue = specs.slice();
    const worker = async () => {
      for (;;) {
        const spec = queue.shift();
        if (!spec) return;
        try {
          const entry = await seedDoc({ spec, tag, api, db, manifest });
          log(`✓ ${spec.slug.padEnd(44)} ${entry.docId}  ${entry.pages.length}p  ${entry.links.length} links`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${spec.slug}: ${msg}`);
          log(`✗ ${spec.slug}: ${msg}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await revokeApiKey({ orgId, keyId: created.key.id });
    writeManifest(manifest);
  }

  log();
  log(`${manifest.docs.length} documents in ${path.relative(process.cwd(), manifestPath(tag))}; key "seed-corpus ${tag}" revoked.`);
  if (manifest.abandonedDocIds.length) log(`${manifest.abandonedDocIds.length} abandoned documents (failed uploads) stay tagged for cleanup.`);
  if (failures.length) {
    log(`${failures.length} failures:`);
    for (const f of failures) log(`  ${f}`);
    process.exitCode = 1;
  }
}

type SeedCtx = { spec: DocSpec; tag: string; api: SeedApi; db: mongoose.mongo.Db; manifest: Manifest };

async function seedDoc(ctx: SeedCtx): Promise<ManifestDoc> {
  const { spec, tag, api, db, manifest } = ctx;
  const docs = db.collection("docs");
  const uploads = db.collection("uploads");
  const save = () => writeManifest(manifest);

  let entry = manifest.docs.find((d) => d.slug === spec.slug) ?? null;
  if (!entry) {
    // A crash between creating the doc and writing the manifest leaves a tagged doc behind: adopt it.
    const orphan = await docs.findOne(
      { seedTag: tag, title: spec.title, isDeleted: { $ne: true }, status: { $ne: "failed" }, _id: { $nin: manifest.abandonedDocIds.map((id) => new Types.ObjectId(id)) } },
      { sort: { createdDate: -1 }, projection: { _id: 1 } },
    );
    if (orphan) {
      entry = { slug: spec.slug, docId: String(orphan._id), uploadId: null, pages: spec.pages.map((p) => p.role), links: [] };
      manifest.docs.push(entry);
      save();
    }
  }

  const abandon = (e: ManifestDoc, why: string) => {
    log(`  ${spec.slug}: abandoning ${e.docId} (${why}); retrying on a new document`);
    manifest.abandonedDocIds.push(e.docId);
    manifest.docs = manifest.docs.filter((d) => d !== e);
    save();
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!entry) {
      const doc = await api.createDoc(spec.title);
      await docs.updateOne({ _id: new Types.ObjectId(doc.id) }, { $set: { seedTag: tag } });
      entry = { slug: spec.slug, docId: doc.id, uploadId: null, pages: spec.pages.map((p) => p.role), links: [] };
      manifest.docs.push(entry);
      save();
    }
    const docOid = new Types.ObjectId(entry.docId);
    const row = await docs.findOne({ _id: docOid }, { projection: { status: 1, slideNodes: 1, isDeleted: 1 } });
    if (!row || row.isDeleted) {
      abandon(entry, "document missing");
      entry = null;
      continue;
    }

    if (row.status !== "ready") {
      const existing = await uploads
        .find({ docId: docOid, status: { $ne: "failed" } }, { projection: { _id: 1, status: 1 } })
        .sort({ createdDate: -1 })
        .toArray();
      const { bytes } = await ensureSpecPdf(spec);
      const fileName = `seedcorpus-${tag}-${spec.slug}.pdf`;
      if (existing.length === 0) {
        if ((await uploads.countDocuments({ docId: docOid })) > 0) {
          abandon(entry, "its first upload failed");
          entry = null;
          continue;
        }
        // Replacement-upload guard, immediately before the only POST /api/uploads in the seed tooling.
        if ((await uploads.countDocuments({ docId: docOid, status: { $ne: "failed" } })) !== 0) {
          throw new Error(`refusing to upload into ${entry.docId}: it already has an upload`);
        }
        entry.uploadId = await api.createFirstUpload({
          docId: entry.docId,
          originalFileName: fileName,
          sizeBytes: bytes.length,
          summary: spec.summary,
          keyPoints: spec.keyPoints,
        });
        save();
        await api.importBytes(entry.uploadId, bytes.toString("base64"), fileName);
        await api.processUpload(entry.uploadId);
      } else {
        const up = existing[0]!;
        entry.uploadId = String(up._id);
        save();
        if (up.status === "uploading") await api.importBytes(entry.uploadId, bytes.toString("base64"), fileName);
        if (up.status === "uploading" || up.status === "uploaded") await api.processUpload(entry.uploadId);
      }
      const status = await api.waitForDoc(entry.docId);
      if (status === "failed") {
        abandon(entry, "processing failed");
        entry = null;
        continue;
      }
      if (status === "timeout") throw new Error(`${entry.docId} not ready after 180s`);
    }

    const ready = await docs.findOne({ _id: docOid }, { projection: { slideNodes: 1 } });
    const slides = Array.isArray(ready?.slideNodes) ? ready!.slideNodes.length : 0;
    if (slides !== spec.pages.length) throw new Error(`${entry.docId}: ${slides} slideNodes, spec has ${spec.pages.length} pages`);
    if (!entry.uploadId) {
      const up = await uploads.findOne({ docId: docOid, status: "completed" }, { projection: { _id: 1 } });
      entry.uploadId = up ? String(up._id) : null;
    }

    const have = new Set((await api.listLinks(entry.docId)).map((l) => l.label));
    for (const link of spec.links) {
      if (have.has(link.label)) continue;
      await api.createLink(entry.docId, link);
    }
    const links = await api.listLinks(entry.docId);
    await docs.updateOne({ _id: docOid }, { $set: { seedTag: tag } });
    await db.collection("sharelinks").updateMany({ docId: docOid }, { $set: { seedTag: tag } });
    entry.links = links.map((l) => ({ shareId: l.shareId, label: l.label, isDefault: l.isDefault, allowDownload: l.allowDownload }));
    save();
    return entry;
  }
  throw new Error("gave up after 3 documents");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
