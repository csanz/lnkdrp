/**
 * Debug: print all Upload versions + DocChange history for a doc.
 *
 * Usage:
 *   tsx scripts/debug-doc-history.ts --docId <docId>
 *
 * Example:
 *   tsx scripts/debug-doc-history.ts --docId 696f041353a89e801f7c5180
 *
 * Env (loaded automatically from .env.local/.env):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional)
 */
import dotenv from "dotenv";
import path from "node:path";
import { Types } from "mongoose";
import { connectMongo } from "../src/lib/mongodb";
import { DocModel } from "../src/lib/models/Doc";
import { DocChangeModel } from "../src/lib/models/DocChange";
import { UploadModel } from "../src/lib/models/Upload";

// Load env the same way Next does for local dev scripts.
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return "";
  return next;
}

function summarizeDupeVersions(label: string, versions: Array<number | null>): Array<{ version: number; count: number }> {
  const counts = new Map<number, number>();
  for (const v of versions) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([version, count]) => ({ version, count }));
}

async function main() {
  const docIdRaw = (arg("docId") ?? "").trim();
  if (!docIdRaw || !Types.ObjectId.isValid(docIdRaw)) {
    console.error("Missing/invalid --docId. Example: tsx scripts/debug-doc-history.ts --docId <mongoObjectId>");
    process.exitCode = 1;
    return;
  }
  const docId = new Types.ObjectId(docIdRaw);

  await connectMongo();

  const doc = await DocModel.findOne({ _id: docId })
    .select({ _id: 1, orgId: 1, userId: 1, title: 1, status: 1, currentUploadId: 1, uploadId: 1 })
    .lean();

  const uploads = (await UploadModel.find({ docId })
    .select({ _id: 1, orgId: 1, userId: 1, version: 1, status: 1, isDeleted: 1, createdDate: 1, updatedDate: 1 })
    .sort({ version: 1, createdDate: 1 })
    .lean()) as Array<Record<string, any>>;

  const changes = (await DocChangeModel.find({ docId })
    .select({
      _id: 1,
      orgId: 1,
      docId: 1,
      fromUploadId: 1,
      toUploadId: 1,
      fromVersion: 1,
      toVersion: 1,
      createdByUserId: 1,
      createdDate: 1,
      updatedDate: 1,
      "diff.summary": 1,
    })
    .sort({ toVersion: 1, createdDate: 1 })
    .lean()) as Array<Record<string, any>>;

  const uploadVersions = uploads.map((u) => (typeof u?.version === "number" ? Number(u.version) : null));
  const changeToVersions = changes.map((c) => (typeof c?.toVersion === "number" ? Number(c.toVersion) : null));

  const out = {
    doc: doc
      ? {
          id: String((doc as any)._id),
          title: typeof (doc as any).title === "string" ? (doc as any).title : null,
          status: typeof (doc as any).status === "string" ? (doc as any).status : null,
          orgId: (doc as any).orgId ? String((doc as any).orgId) : null,
          userId: (doc as any).userId ? String((doc as any).userId) : null,
          currentUploadId: (doc as any).currentUploadId ? String((doc as any).currentUploadId) : null,
          uploadId: (doc as any).uploadId ? String((doc as any).uploadId) : null,
        }
      : null,
    uploads: {
      count: uploads.length,
      versions: uploadVersions.filter((v): v is number => typeof v === "number").sort((a, b) => a - b),
      dupes: summarizeDupeVersions("upload", uploadVersions),
      rows: uploads.map((u) => ({
        id: u?._id ? String(u._id) : null,
        version: typeof u?.version === "number" ? u.version : null,
        status: typeof u?.status === "string" ? u.status : null,
        isDeleted: Boolean(u?.isDeleted),
        orgId: u?.orgId ? String(u.orgId) : null,
        userId: u?.userId ? String(u.userId) : null,
        createdDate: u?.createdDate instanceof Date ? u.createdDate.toISOString() : null,
        updatedDate: u?.updatedDate instanceof Date ? u.updatedDate.toISOString() : null,
      })),
    },
    docChanges: {
      count: changes.length,
      toVersions: changeToVersions.filter((v): v is number => typeof v === "number").sort((a, b) => a - b),
      dupes: summarizeDupeVersions("docChange.toVersion", changeToVersions),
      rows: changes.map((c) => ({
        id: c?._id ? String(c._id) : null,
        orgId: c?.orgId ? String(c.orgId) : null,
        fromVersion: typeof c?.fromVersion === "number" ? c.fromVersion : null,
        toVersion: typeof c?.toVersion === "number" ? c.toVersion : null,
        fromUploadId: c?.fromUploadId ? String(c.fromUploadId) : null,
        toUploadId: c?.toUploadId ? String(c.toUploadId) : null,
        createdByUserId: c?.createdByUserId ? String(c.createdByUserId) : null,
        createdDate: c?.createdDate instanceof Date ? c.createdDate.toISOString() : null,
        updatedDate: c?.updatedDate instanceof Date ? c.updatedDate.toISOString() : null,
        summary:
          c?.diff && typeof c.diff === "object" && typeof (c.diff as any).summary === "string" ? (c.diff as any).summary : "",
      })),
    },
  };

  // Pretty-print JSON so it can be pasted into chat/issues.
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

void main();

