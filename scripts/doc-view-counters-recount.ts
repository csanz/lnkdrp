/**
 * Recount `Doc.numberOfViews` / `Doc.numberOfPagesViewed` from the analytics rows, under the
 * document-scope rule.
 *
 * Both counters are ingest-time `$inc`s, and since project links shipped the ingest obeys the
 * locked rule — a read through a project link is the data room's view, not the document's
 * (`@/lib/analytics/docScope`, docs/METRICS.md) — so neither counter moves for one. History does
 * not: every data-room read taken *before* that guard landed is still inside the stored numbers,
 * and the dashboard's four sharing tiles are sums of exactly these two fields. On the workspace
 * that found this, the tiles reported 14 views over two documents whose own metrics pages, whose
 * snapshots and whose QuickStats all reported 7 — permanently, because no later traffic can
 * subtract a past increment.
 *
 * This is the one-time pass that makes the counters mean what they now claim: recompute them from
 * `ShareView`, recipients only, with every project-link slug excluded, which is the same query the
 * document metrics route and `rollupDocMetrics` answer from.
 *
 *     numberOfViews       = one per doc-scoped recipient row  (a row is a viewer)
 *     numberOfPagesViewed = the pages those rows reached      (sum of |pagesSeen|)
 *
 * Usage:
 * - Dry run:  npx tsx --env-file=.env.local scripts/doc-view-counters-recount.ts --dry-run
 * - Apply:    npx tsx --env-file=.env.local scripts/doc-view-counters-recount.ts
 *
 * Optional:
 * - --org <orgId>   restrict to one workspace's documents
 * - --limit <n>     stop after n documents (a smoke test on production data)
 *
 * Idempotent: a second run reports zero changed. Safe to run while the app is serving — the two
 * fields are `$inc`ed by live traffic, so a document read during the pass may be recounted one view
 * low; the nightly rollup and the next run both correct it, and no read path treats these counters
 * as truth any more (`/api/docs/:id/shareviews` recomputes, and uses `numberOfViews` only as a
 * floor for documents with no project-link contamination).
 *
 * Writes run with `timestamps: false`: this is maintenance, and `updatedDate` is read as "last
 * activity" elsewhere — a repair pass must not look like traffic.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { projectLinkSlugsForDocs } from "@/lib/analytics/docScope";
import { RECIPIENT_ONLY_MATCH, shareIdClause } from "@/lib/analytics/shareViewAggregates";

/** Documents per pass. One aggregate and one slug lookup per batch, so bigger is not better. */
const BATCH = 200;

type DocRow = {
  _id: Types.ObjectId;
  numberOfViews?: number | null;
  numberOfPagesViewed?: number | null;
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
  const orgRaw = argValue("--org");
  const limitRaw = argValue("--limit");
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.floor(Number(limitRaw))) : null;

  await connectMongo();

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (orgRaw) {
    if (!Types.ObjectId.isValid(orgRaw)) throw new Error(`--org is not an ObjectId: ${orgRaw}`);
    filter.orgId = new Types.ObjectId(orgRaw);
  }

  const docs = (await DocModel.find(filter)
    .select({ _id: 1, numberOfViews: 1, numberOfPagesViewed: 1 })
    .sort({ _id: 1 })
    .limit(limit ?? 0)
    .lean()) as unknown as DocRow[];

  let changed = 0;
  let viewsBefore = 0;
  let viewsAfter = 0;
  let pagesBefore = 0;
  let pagesAfter = 0;
  const sample: Array<{ docId: string; views: [number, number]; pages: [number, number] }> = [];

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const ids = batch.map((d) => d._id);
    // A project slug is a project slug for every document in the batch, so one pair of reads
    // answers for all of them — the same trick `rollupDocMetrics` uses.
    const foreignShareIds = await projectLinkSlugsForDocs(ids);
    const rows = (await ShareViewModel.aggregate([
      { $match: { docId: { $in: ids }, ...shareIdClause({ except: foreignShareIds }), ...RECIPIENT_ONLY_MATCH } },
      {
        $group: {
          _id: "$docId",
          views: { $sum: 1 },
          pages: { $sum: { $size: { $ifNull: ["$pagesSeen", []] } } },
        },
      },
    ])) as Array<{ _id: Types.ObjectId; views?: number; pages?: number }>;

    const truth = new Map<string, { views: number; pages: number }>();
    for (const r of rows) {
      truth.set(String(r._id), {
        views: typeof r.views === "number" && Number.isFinite(r.views) ? r.views : 0,
        pages: typeof r.pages === "number" && Number.isFinite(r.pages) ? r.pages : 0,
      });
    }

    for (const doc of batch) {
      const t = truth.get(String(doc._id)) ?? { views: 0, pages: 0 };
      const storedViews = doc.numberOfViews ?? 0;
      const storedPages = doc.numberOfPagesViewed ?? 0;
      viewsBefore += storedViews;
      pagesBefore += storedPages;
      viewsAfter += t.views;
      pagesAfter += t.pages;
      if (storedViews === t.views && storedPages === t.pages) continue;
      changed += 1;
      if (sample.length < 25) {
        sample.push({ docId: String(doc._id), views: [storedViews, t.views], pages: [storedPages, t.pages] });
      }
      if (dryRun) continue;
      await DocModel.updateOne(
        { _id: doc._id },
        { $set: { numberOfViews: t.views, numberOfPagesViewed: t.pages } },
        { timestamps: false },
      );
    }
  }

  log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        org: orgRaw ?? null,
        docsChecked: docs.length,
        docsChanged: changed,
        totals: { views: { before: viewsBefore, after: viewsAfter }, pagesViewed: { before: pagesBefore, after: pagesAfter } },
        sample,
      },
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
