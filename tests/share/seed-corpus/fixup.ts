/**
 * After the bulk traffic: move the seed's own rows to their planned times, so the corpus reads as
 * four weeks of activity instead of ten minutes of it.
 *
 * The ingest stamps server time on everything, so this rewrites, with the native driver and explicit
 * dates, only rows of tagged documents written by seed botIds (bulk readers and owner previews).
 * Live-tail rows are never touched. Steps:
 *   1. ShareVisit startedAt / lastEventAt (+ createdDate / updatedDate)
 *   2. ShareView createdDate / lastViewedAt / updatedDate, downloadsByDay re-keyed
 *   3. ActivityEvent createdDate (+ meta.seedTag)
 *   4. docs / uploads / sharelinks createdDate
 *   5. docs.pageSlugs from page roles and headings
 *   6. planned disables and expiries
 *   7. link counters reconcile + metrics rollup (in-process: `npm run metrics:rollup:once` never exits)
 */
import { createHash } from "node:crypto";

import type mongoose from "mongoose";
import { Types } from "mongoose";

import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";
import { rollupDocMetrics } from "@/lib/metrics/rollupDocMetrics";

import type { DocSpec } from "./content";
import type { Plan, PlannedPerson } from "./plan";
import { compileVisit } from "./wire";

type Db = mongoose.mongo.Db;

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type FixupReport = Record<string, number>;

export async function runFixup(input: {
  db: Db;
  plan: Plan;
  specsBySlug: Map<string, DocSpec>;
  orgId: string;
  tag: string;
  log: (s: string) => void;
  skipRollup?: boolean;
}): Promise<FixupReport> {
  const { db, plan, tag, log } = input;
  const report: FixupReport = {};
  const count = (k: string, n: number) => (report[k] = (report[k] ?? 0) + n);
  const docById = new Map(plan.docs.map((d) => [d.docId, d]));
  const docOids = plan.docs.map((d) => new Types.ObjectId(d.docId));
  const people: PlannedPerson[] = [...plan.people, ...plan.ownerPreviews];

  // 1 + 2: visits and views, per person.
  const { firstStartByViewer } = await backdateViewers({ db, plan, people, count });

  // 3: activity events of tagged docs.
  const downloadAtByViewer = new Map(people.filter((p) => p.download).map((p) => [`${p.shareId}|${sha256(p.botId)}`, p.download!.atMs]));
  const linkCreatedAt = new Map(plan.docs.flatMap((d) => d.links.map((l) => [l.shareId, l.createdAt] as const)));
  const events = await db
    .collection("activityevents")
    .find({ docId: { $in: docOids } }, { projection: { type: 1, docId: 1, meta: 1, createdDate: 1 } })
    .toArray();
  const eventOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  for (const e of events) {
    const meta = (e.meta ?? {}) as { shareId?: string; viewerKey?: string; seedTag?: string };
    const type = String(e.type ?? "");
    const doc = docById.get(String(e.docId));
    let when: number | undefined;
    if (type === "share.viewed" && meta.shareId && meta.viewerKey) {
      when = firstStartByViewer.get(`${meta.shareId}|${meta.viewerKey}`);
      // A viewer the plan does not know (live tail) keeps its real time and no tag.
      if (when === undefined) continue;
    } else if (type === "share.downloaded" && meta.shareId && meta.viewerKey) {
      when = downloadAtByViewer.get(`${meta.shareId}|${meta.viewerKey}`);
      if (when === undefined) continue;
    } else if (type.startsWith("share_link.")) {
      when = (meta.shareId && linkCreatedAt.get(meta.shareId)) || doc?.createdAt;
    } else if (type.startsWith("doc.") || type.startsWith("upload.") || type.startsWith("summary.")) {
      when = doc?.createdAt;
    }
    const set: Record<string, unknown> = { "meta.seedTag": tag };
    if (when !== undefined) set.createdDate = new Date(when);
    eventOps.push({ updateOne: { filter: { _id: e._id }, update: { $set: set } } });
  }
  if (eventOps.length) count("activityevents", (await db.collection("activityevents").bulkWrite(eventOps, { ordered: false })).modifiedCount);

  // 4 + 5: docs, uploads, links.
  const docOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  const uploadOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  const linkOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  for (const d of plan.docs) {
    const spec = input.specsBySlug.get(d.slug);
    const set: Record<string, unknown> = { createdDate: new Date(d.createdAt) };
    if (spec) {
      set.pageSlugs = spec.pages.map((p, i) => ({ pageNumber: i + 1, slug: kebab(`${p.role} ${p.heading}`).slice(0, 60) }));
    }
    docOps.push({ updateOne: { filter: { _id: new Types.ObjectId(d.docId), seedTag: tag }, update: { $set: set } } });
    uploadOps.push({ updateMany: { filter: { docId: new Types.ObjectId(d.docId) }, update: { $set: { createdDate: new Date(d.createdAt) } } } });
    for (const l of d.links) {
      linkOps.push({ updateOne: { filter: { shareId: l.shareId, seedTag: tag }, update: { $set: { createdDate: new Date(l.createdAt) } } } });
    }
  }
  if (docOps.length) count("docs", (await db.collection("docs").bulkWrite(docOps, { ordered: false })).modifiedCount);
  if (uploadOps.length) count("uploads", (await db.collection("uploads").bulkWrite(uploadOps, { ordered: false })).modifiedCount);
  if (linkOps.length) count("sharelinks", (await db.collection("sharelinks").bulkWrite(linkOps, { ordered: false })).modifiedCount);

  // 6: disables and expiries, all dated before the run started.
  for (const r of plan.refused) {
    if (r.disableAt > Date.now()) throw new Error(`refused link ${r.shareId}: disableAt ${new Date(r.disableAt).toISOString()} is in the future`);
    const update =
      r.kind === "expired"
        ? { $set: { expiresAt: new Date(r.disableAt) } }
        : { $set: { enabled: false, updatedDate: new Date(r.disableAt) } };
    const res = await db.collection("sharelinks").updateOne({ shareId: r.shareId, seedTag: tag }, update);
    count(`links ${r.kind}`, res.matchedCount);
  }
  const expired = await db
    .collection("sharelinks")
    .find({ shareId: { $in: plan.refused.filter((r) => r.kind === "expired").map((r) => r.shareId) } }, { projection: { expiresAt: 1 } })
    .toArray();
  for (const l of expired) {
    if (!l.expiresAt || new Date(l.expiresAt).getTime() > Date.now()) throw new Error(`link ${String(l._id)} expiresAt is not in the past`);
  }

  // 7: derived counters.
  const reconciled = await reconcileShareLinkCounters({ orgId: input.orgId });
  count("links reconciled", reconciled.linksReconciled);
  if (!input.skipRollup) {
    const rollup = await rollupDocMetrics({});
    log(`metrics rollup: ${rollup.processed} docs`);
  }
  return report;
}

/**
 * Steps 1 and 2 for some people: each planned visit's ShareVisit row to its planned times, and the
 * person's ShareView to their first start and last activity. Visits with no row are skipped.
 */
export async function backdateViewers(input: {
  db: Db;
  plan: Pick<Plan, "docs">;
  people: PlannedPerson[];
  count: (k: string, n: number) => void;
}): Promise<{ firstStartByViewer: Map<string, number> }> {
  const { db, people, count } = input;
  const docById = new Map(input.plan.docs.map((d) => [d.docId, d]));
  const visitOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  const viewOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  const firstStartByViewer = new Map<string, number>();
  for (const p of people) {
    const botIdHash = sha256(p.botId);
    const docOid = new Types.ObjectId(p.docId);
    const pageCount = docById.get(p.docId)!.pageCount;
    let firstStart = Number.POSITIVE_INFINITY;
    let lastEnd = 0;
    for (const v of p.visits) {
      const visitIdHash = sha256(v.visitId);
      const row = await db
        .collection("sharevisits")
        .findOne({ shareId: p.shareId, botIdHash, visitIdHash, docId: docOid }, { projection: { pageEvents: 1 } });
      if (!row) continue;
      const events = (Array.isArray(row.pageEvents) ? row.pageEvents : []) as Array<{ enteredAt?: Date | null; leftAt?: Date | null }>;
      const entered = events.map((e) => (e.enteredAt ? new Date(e.enteredAt).getTime() : NaN)).filter(Number.isFinite);
      const left = events.map((e) => (e.leftAt ? new Date(e.leftAt).getTime() : NaN)).filter(Number.isFinite);
      const { lastRequestAt } = compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: pageCount, intro: p.intro });
      // The browser's first POST (load) stamps startedAt; its last POST stamps lastEventAt.
      const startedAt = Math.min(v.startAt, ...entered);
      const lastEventAt = Math.max(lastRequestAt, ...left);
      visitOps.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { startedAt: new Date(startedAt), lastEventAt: new Date(lastEventAt), createdDate: new Date(startedAt), updatedDate: new Date(lastEventAt) } },
        },
      });
      firstStart = Math.min(firstStart, startedAt);
      lastEnd = Math.max(lastEnd, lastEventAt);
    }
    if (!Number.isFinite(firstStart)) continue;
    firstStartByViewer.set(`${p.shareId}|${botIdHash}`, firstStart);
    const view = await db
      .collection("shareviews")
      .findOne({ shareId: p.shareId, botIdHash, docId: docOid }, { projection: { downloadsByDay: 1 } });
    if (!view) continue;
    const set: Record<string, unknown> = {
      createdDate: new Date(firstStart),
      lastViewedAt: new Date(Math.max(lastEnd, p.download?.atMs ?? 0)),
      updatedDate: new Date(Math.max(lastEnd, p.download?.atMs ?? 0)),
    };
    const byDay = (view.downloadsByDay ?? {}) as Record<string, unknown>;
    const downloads = Object.values(byDay).reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0);
    if (downloads > 0) set.downloadsByDay = { [dayKey(p.download?.atMs ?? lastEnd)]: downloads };
    viewOps.push({ updateOne: { filter: { _id: view._id }, update: { $set: set } } });
  }
  if (visitOps.length) count("sharevisits", (await db.collection("sharevisits").bulkWrite(visitOps, { ordered: false })).modifiedCount);
  if (viewOps.length) count("shareviews", (await db.collection("shareviews").bulkWrite(viewOps, { ordered: false })).modifiedCount);
  return { firstStartByViewer };
}
