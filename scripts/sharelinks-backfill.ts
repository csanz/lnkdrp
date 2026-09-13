/**
 * Backfill: one `sharelinks` row per document (docs/prds/lnkdrp-multi-links.md, M1).
 *
 * Every document's current share settings become its **default link** (`isDefault: true`, label
 * "Default link", same `shareId`), so `/s/:shareId` keeps resolving and the Free cap — which now
 * counts links — sees the same number it saw when it counted shared documents.
 *
 * Usage:
 * - Dry run (default):  npm run sharelinks:backfill -- --dry-run
 * - Apply:              npm run sharelinks:backfill
 *
 * Optional:
 * - --limit <n>         max documents scanned (default: all)
 * - --org <orgId>       restrict to one workspace
 *
 * Idempotent: `ensureDefaultLink` is a no-op when the row already exists, and `syncDocShareState`
 * only re-mirrors what the links already say. Safe to run repeatedly, and safe to run while the
 * app is serving (resolution creates the same row lazily).
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ensureDefaultLink, syncDocShareState } from "@/lib/share/links";

type DocRow = {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  userId?: Types.ObjectId | null;
  shareId?: string | null;
  shareEnabled?: boolean | null;
  shareAllowPdfDownload?: boolean | null;
  shareAllowRevisionHistory?: boolean | null;
  sharePasswordSalt?: string | null;
  sharePasswordHash?: string | null;
  sharePasswordEnc?: string | null;
  sharePasswordEncIv?: string | null;
  sharePasswordEncTag?: string | null;
  isDeleted?: boolean | null;
  isArchived?: boolean | null;
  title?: string | null;
};

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const v = process.argv[idx + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const limitRaw = argValue("--limit");
  const limit = limitRaw ? Math.max(1, Math.floor(Number(limitRaw) || 0)) : 0;
  const orgRaw = argValue("--org");
  if (orgRaw && !Types.ObjectId.isValid(orgRaw)) throw new Error(`Invalid --org: ${orgRaw}`);

  await connectMongo();

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (orgRaw) filter.orgId = new Types.ObjectId(orgRaw);

  const query = DocModel.find(filter).select({
    _id: 1,
    orgId: 1,
    userId: 1,
    shareId: 1,
    shareEnabled: 1,
    shareAllowPdfDownload: 1,
    shareAllowRevisionHistory: 1,
    sharePasswordSalt: 1,
    sharePasswordHash: 1,
    sharePasswordEnc: 1,
    sharePasswordEncIv: 1,
    sharePasswordEncTag: 1,
    isArchived: 1,
    title: 1,
  });
  if (limit) query.limit(limit);
  const docs = (await query.lean()) as unknown as DocRow[];

  let created = 0;
  let existing = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const doc of docs) {
    // `ensureDefaultLink` needs an org to hang the link on (the cap is per workspace).
    if (!doc.orgId) {
      skipped += 1;
      problems.push(`${String(doc._id)} (${doc.title ?? "untitled"}): no orgId`);
      continue;
    }
    const already = await ShareLinkModel.countDocuments({ docId: doc._id, isDefault: true });
    if (already) {
      existing += 1;
      if (!dryRun) await syncDocShareState(doc._id);
      continue;
    }
    if (dryRun) {
      created += 1;
      log(
        `would create default link for ${String(doc._id)} shareId=${doc.shareId ?? "(new)"} ` +
          `enabled=${doc.shareEnabled !== false} download=${Boolean(doc.shareAllowPdfDownload)} ` +
          `history=${Boolean(doc.shareAllowRevisionHistory)} password=${Boolean(doc.sharePasswordHash)}`,
      );
      continue;
    }
    try {
      const link = await ensureDefaultLink(doc);
      await syncDocShareState(doc._id);
      created += 1;
      log(`created default link ${String(link._id)} for doc ${String(doc._id)} shareId=${link.shareId}`);
    } catch (e) {
      skipped += 1;
      problems.push(`${String(doc._id)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const activeLinks = await ShareLinkModel.countDocuments({
    enabled: true,
    archivedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    ...(orgRaw ? { orgId: new Types.ObjectId(orgRaw) } : {}),
  });

  log(
    JSON.stringify(
      { dryRun, scannedDocs: docs.length, created, alreadyLinked: existing, skipped, activeLinksAfter: activeLinks, problems },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
