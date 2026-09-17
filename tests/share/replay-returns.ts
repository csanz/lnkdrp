/**
 * Replace a seeded corpus's return visits with the ones the current plan gives, without reseeding.
 *
 * Run:
 *   EMAIL_TRANSPORT=console npx tsx --env-file=.env.local tests/share/replay-returns.ts --tag <TAG>
 *     [--dry-run] [--lanes 4] [--pace 0.3-1.2] [--post-gap 150-250]
 *
 * The plan keeps every first visit, intro, link pick and refused link of a seed where it was (the
 * return visits draw from their own stream), so only returners' later visits and, for the few who
 * downloaded, the download time change. The script refuses to run when the rebuilt plan disagrees
 * with the manifest on anything else.
 *
 * Per returner: delete their ShareVisit rows other than the first visit, set their ShareView's
 * lifetime totals back to the sum of the rows that remain (checked to hold for every returner before
 * anything is written), send the new visits through the public stats ingest exactly as
 * traffic-corpus.ts does, then backdate only those people's rows with the fix-up's own step. A link
 * the plan disabled or expired is lifted for the few seconds its returner is sent and put back at
 * the planned time. Link and doc `updatedDate`s moved by the ingest are restored, then link counters
 * are reconciled and the touched docs' metrics rolled up.
 *
 * Never sends downloads, download requests, invites or cron calls. Resumable through
 * tests/share/.seed/<TAG>/returns-replay.json: a visit that was started but not finished is deleted
 * and sent again.
 */
import fs from "node:fs";
import path from "node:path";

import mongoose, { Types } from "mongoose";

import { describePacing, pause, resolvePacing, type Pacing } from "../pace";
import {
  argValue as arg,
  assertConsoleEmail,
  assertTag,
  readManifest,
  SEED_DIR,
  waitForServer,
  writeJsonAtomic,
  writeManifest,
  type Manifest,
  type ManifestPerson,
} from "./seed-corpus/api";
import { backdateViewers, sha256 } from "./seed-corpus/fixup";
import { buildPlan, MINUTE, type Plan, type PlannedPerson, type PlannedVisit } from "./seed-corpus/plan";
import { compileVisit, sendRequests } from "./seed-corpus/wire";
import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";
import { connectMongo } from "@/lib/mongodb";
import { rollupDocMetrics } from "@/lib/metrics/rollupDocMetrics";

assertConsoleEmail();

type Db = mongoose.mongo.Db;

type ReplayState = {
  tag: string;
  startedAt: string;
  /** updatedDate of every link and doc a returner touches, as it was before the first write. */
  linkUpdatedDate: Record<string, string | null>;
  docUpdatedDate: Record<string, string | null>;
  /** Refused links lifted for a send: their state before the lift. */
  lifted: Record<string, { enabled: boolean; expiresAt: string | null }>;
  startedVisits: string[];
  doneVisits: string[];
  donePeople: number[];
  finishedAt: string | null;
};

function log(s = ""): void {
  console.log(s);
}

const iso = (ms: number) => new Date(ms).toISOString();
const statePath = (tag: string) => path.join(SEED_DIR, tag, "returns-replay.json");

function parseRange(raw: string, name: string): [number, number] {
  const [a, b] = raw.split("-").map(Number);
  const lo = a ?? NaN;
  const hi = b ?? lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) throw new Error(`--${name} expects <min>-<max>, got "${raw}"`);
  return [lo, hi];
}

const visitKey = (p: PlannedPerson, v: PlannedVisit) => `${p.n}.${v.visitId.slice(v.visitId.lastIndexOf("_") + 1)}`;

function pathOf(v: PlannedVisit): string {
  return v.stops.map((s) => `${s.page}${s.flip ? "'" : ""}`).join("→");
}

/** Everything but returners' later visits and downloads must match what was sent. */
function assertPlanMatchesManifest(plan: Plan, manifest: Manifest): void {
  const traffic = manifest.traffic!;
  const problems: string[] = [];
  const planned = new Map([...plan.people, ...plan.ownerPreviews].map((p) => [p.n, p]));
  const sameVisit = (a: PlannedVisit, b: ManifestPerson["visits"][number]) =>
    a.visitId === b.visitId && iso(a.startAt) === b.startAt && iso(a.endAt) === b.endAt;
  for (const m of [...traffic.people.filter((p) => !p.live), ...traffic.ownerPreviews]) {
    const p = planned.get(m.n);
    if (!p || p.botId !== m.botId || p.shareId !== m.shareId || p.archetype !== m.archetype || p.docId !== m.docId) {
      problems.push(`person ${m.n}: identity differs`);
      continue;
    }
    if (!sameVisit(p.visits[0]!, m.visits[0]!)) problems.push(`person ${m.n}: first visit differs`);
    if (p.archetype === "returner") {
      if (Boolean(p.download) !== Boolean(m.download)) problems.push(`person ${m.n}: download planned ${Boolean(p.download)}, sent ${Boolean(m.download)}`);
      continue;
    }
    if (p.visits.length !== m.visits.length || p.visits.some((v, i) => !sameVisit(v, m.visits[i]!))) problems.push(`person ${m.n}: visits differ`);
    if ((p.download ? iso(p.download.atMs) : null) !== m.download) problems.push(`person ${m.n}: download differs`);
  }
  const refused = (xs: Array<{ shareId: string; kind: string }>) => JSON.stringify(xs.map((r) => [r.shareId, r.kind]));
  if (refused(plan.refused) !== refused(traffic.refused)) problems.push("refused links differ");
  if (problems.length) {
    throw new Error(`the rebuilt plan does not match the manifest, so this seed cannot be replayed in place:\n  ${problems.slice(0, 20).join("\n  ")}`);
  }
}

type VisitRow = { _id: Types.ObjectId; visitIdHash: string; timeSpentMs?: number; pageTimeMsByPage?: Record<string, number>; pagesSeen?: number[] };

async function rowsOf(db: Db, p: PlannedPerson): Promise<VisitRow[]> {
  return (await db
    .collection("sharevisits")
    .find(
      { shareId: p.shareId, botIdHash: sha256(p.botId), docId: new Types.ObjectId(p.docId) },
      { projection: { visitIdHash: 1, timeSpentMs: 1, pageTimeMsByPage: 1, pagesSeen: 1 } },
    )
    .toArray()) as unknown as VisitRow[];
}

/** A ShareView's lifetime totals as the sum of its visit rows (every seeded POST carries a visitId). */
function totalsOf(rows: VisitRow[]): { timeSpentMs: number; pageTimeMsByPage: Record<string, number>; pagesSeen: number[] } {
  const pageTimeMsByPage: Record<string, number> = {};
  const seen = new Set<number>();
  let timeSpentMs = 0;
  for (const r of rows) {
    timeSpentMs += r.timeSpentMs ?? 0;
    for (const [k, ms] of Object.entries(r.pageTimeMsByPage ?? {})) pageTimeMsByPage[k] = (pageTimeMsByPage[k] ?? 0) + ms;
    for (const s of r.pagesSeen ?? []) seen.add(s);
  }
  return { timeSpentMs, pageTimeMsByPage, pagesSeen: [...seen].sort((a, b) => a - b) };
}

async function viewMatchesRows(db: Db, p: PlannedPerson): Promise<string | null> {
  const view = await db
    .collection("shareviews")
    .findOne({ shareId: p.shareId, botIdHash: sha256(p.botId) }, { projection: { timeSpentMs: 1, pageTimeMsByPage: 1, pagesSeen: 1 } });
  if (!view) return "no ShareView row";
  const t = totalsOf(await rowsOf(db, p));
  const viewPages = (view.pageTimeMsByPage ?? {}) as Record<string, number>;
  const keys = new Set([...Object.keys(viewPages), ...Object.keys(t.pageTimeMsByPage)]);
  if ((view.timeSpentMs ?? 0) !== t.timeSpentMs) return `timeSpentMs ${view.timeSpentMs} vs rows ${t.timeSpentMs}`;
  for (const k of keys) if ((viewPages[k] ?? 0) !== (t.pageTimeMsByPage[k] ?? 0)) return `page ${k} ms ${viewPages[k]} vs rows ${t.pageTimeMsByPage[k]}`;
  const seen = [...new Set<number>((view.pagesSeen ?? []) as number[])].sort((a, b) => a - b);
  if (JSON.stringify(seen) !== JSON.stringify(t.pagesSeen)) return `pagesSeen ${JSON.stringify(seen)} vs rows ${JSON.stringify(t.pagesSeen)}`;
  return null;
}

async function main(): Promise<void> {
  const tag = assertTag(arg("tag"));
  const dryRun = process.argv.includes("--dry-run");
  const lanes = Math.max(1, Math.min(8, Number(arg("lanes") ?? 4)));
  const postGap = parseRange(arg("post-gap") ?? "150-250", "post-gap");
  if (!process.argv.includes("--pace") && !process.argv.includes("--fast")) process.argv.push("--pace", "0.3-1.2");
  const pacing: Pacing = resolvePacing();

  const manifest = readManifest(tag);
  if (!manifest?.traffic) throw new Error(`no manifest with traffic for ${tag}`);
  const traffic = manifest.traffic;
  if (!traffic.fixupAt) throw new Error(`${tag} was never fixed up; finish traffic-corpus.ts first`);
  const plan = buildPlan({
    tag,
    seed: traffic.seed,
    runStart: Date.parse(traffic.runStart),
    docs: manifest.docs.map((d) => ({ slug: d.slug, docId: d.docId, pages: d.pages, links: d.links })),
    smoke: manifest.docs.length < 50,
  });
  assertPlanMatchesManifest(plan, manifest);

  const sent = new Map(traffic.people.filter((p) => !p.live).map((p) => [p.n, p]));
  const returners = plan.people.filter((p) => p.archetype === "returner" && sent.get(p.n)?.status === "sent");
  const docById = new Map(plan.docs.map((d) => [d.docId, d]));
  const refusedById = new Map(plan.refused.map((r) => [r.shareId, r]));

  let posts = 0;
  for (const p of returners) {
    for (const v of p.visits.slice(1)) {
      posts += compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: docById.get(p.docId)!.pageCount, intro: p.intro }).requests.length;
    }
  }
  const newVisits = returners.reduce((a, p) => a + p.visits.length - 1, 0);
  log(`replay ${tag}: ${returners.length} returners, ${newVisits} return visits, ${posts} stats POSTs · ${lanes} lanes · ${describePacing(pacing)} between visits`);

  if (dryRun) {
    for (const p of returners) {
      const old = sent.get(p.n)!.visits.slice(1);
      log(`  ${p.n} ${p.slug} ${refusedById.has(p.shareId) ? `(link ${refusedById.get(p.shareId)!.kind}) ` : ""}was ${old.map((v) => v.startAt).join(", ")}`);
      for (const v of p.visits.slice(1)) log(`      ${iso(v.startAt)} ${v.returnStyle} ${pathOf(v)}`);
    }
    log("dry run: no requests sent, no database writes.");
    return;
  }

  await waitForServer();
  await connectMongo();
  const db = mongoose.connection.db!;

  const existing = fs.existsSync(statePath(tag)) ? (JSON.parse(fs.readFileSync(statePath(tag), "utf8")) as ReplayState) : null;
  if (existing?.finishedAt) throw new Error(`${tag} was already replayed at ${existing.finishedAt} (${statePath(tag)})`);
  const state: ReplayState = existing ?? {
    tag,
    startedAt: iso(Date.now()),
    linkUpdatedDate: {},
    docUpdatedDate: {},
    lifted: {},
    startedVisits: [],
    doneVisits: [],
    donePeople: [],
    finishedAt: null,
  };
  const save = () => writeJsonAtomic(statePath(tag), state);

  if (!existing) {
    // Check the one assumption the reset relies on before writing anything.
    const known = new Set(returners.flatMap((p) => [...sent.get(p.n)!.visits.map((v) => v.visitIdHash), ...p.visits.map((v) => sha256(v.visitId))]));
    const problems: string[] = [];
    for (const p of returners) {
      const mismatch = await viewMatchesRows(db, p);
      if (mismatch) problems.push(`${p.botId}: ${mismatch}`);
      const rows = await rowsOf(db, p);
      if (!rows.some((r) => r.visitIdHash === sha256(p.visits[0]!.visitId))) problems.push(`${p.botId}: first visit row missing`);
      for (const r of rows) if (!known.has(r.visitIdHash)) problems.push(`${p.botId}: unplanned visit row ${String(r._id)}`);
    }
    if (problems.length) throw new Error(`not replaying; rows are not what the seed wrote:\n  ${problems.slice(0, 20).join("\n  ")}`);
    const links = await db
      .collection("sharelinks")
      .find({ shareId: { $in: [...new Set(returners.map((p) => p.shareId))] } }, { projection: { shareId: 1, updatedDate: 1 } })
      .toArray();
    for (const l of links) state.linkUpdatedDate[String(l.shareId)] = l.updatedDate ? new Date(l.updatedDate).toISOString() : null;
    const docs = await db
      .collection("docs")
      .find({ _id: { $in: [...new Set(returners.map((p) => p.docId))].map((id) => new Types.ObjectId(id)) } }, { projection: { updatedDate: 1 } })
      .toArray();
    for (const d of docs) state.docUpdatedDate[String(d._id)] = d.updatedDate ? new Date(d.updatedDate).toISOString() : null;
    save();
  } else {
    log(`resuming: ${state.donePeople.length}/${returners.length} people done; waiting 5s for any earlier ingest to drain`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  const done = new Set(state.doneVisits);
  const donePeople = new Set(state.donePeople);
  const queue = returners.filter((p) => !donePeople.has(p.n));
  const t0 = Date.now();
  let finished = donePeople.size;

  const lift = async (shareId: string) => {
    const row = await db.collection("sharelinks").findOne({ shareId, seedTag: tag }, { projection: { enabled: 1, expiresAt: 1 } });
    if (!row) throw new Error(`refused link ${shareId} not found`);
    state.lifted[shareId] ??= { enabled: row.enabled !== false, expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null };
    save();
    await db.collection("sharelinks").updateOne({ _id: row._id }, { $set: { enabled: true }, $unset: { expiresAt: "" } });
  };
  // The same writes as the fix-up's step 6, at the planned time.
  const refuse = async (r: Plan["refused"][number]) => {
    if (r.disableAt > Date.now()) throw new Error(`refused link ${r.shareId}: disableAt ${iso(r.disableAt)} is in the future`);
    const update =
      r.kind === "expired" ? { $set: { expiresAt: new Date(r.disableAt) } } : { $set: { enabled: false, updatedDate: new Date(r.disableAt) } };
    return (await db.collection("sharelinks").updateOne({ shareId: r.shareId, seedTag: tag }, update)).matchedCount;
  };

  const replayPerson = async (p: PlannedPerson) => {
    const botIdHash = sha256(p.botId);
    const keep = new Set([sha256(p.visits[0]!.visitId), ...p.visits.slice(1).filter((v) => done.has(visitKey(p, v))).map((v) => sha256(v.visitId))]);
    const rows = await rowsOf(db, p);
    const drop = rows.filter((r) => !keep.has(r.visitIdHash));
    if (drop.length) await db.collection("sharevisits").deleteMany({ _id: { $in: drop.map((r) => r._id) } });
    const before = await db.collection("shareviews").findOne({ shareId: p.shareId, botIdHash }, { projection: { pagesSeen: 1 } });
    const totals = totalsOf(rows.filter((r) => keep.has(r.visitIdHash)));
    await db.collection("shareviews").updateOne({ shareId: p.shareId, botIdHash }, { $set: totals });
    // The ingest counts a page into Doc.numberOfPagesViewed the first time a viewer's row gains it.
    const seenDelta = totals.pagesSeen.length - new Set<number>((before?.pagesSeen ?? []) as number[]).size;
    if (seenDelta) await db.collection("docs").updateOne({ _id: new Types.ObjectId(p.docId) }, { $inc: { numberOfPagesViewed: seenDelta } });

    const refused = refusedById.get(p.shareId);
    if (refused) await lift(p.shareId);
    const pageCount = docById.get(p.docId)!.pageCount;
    for (const v of p.visits.slice(1)) {
      const key = visitKey(p, v);
      if (done.has(key)) continue;
      state.startedVisits.push(key);
      save();
      const { requests } = compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: pageCount, intro: p.intro });
      const res = await sendRequests(requests, { ip: p.ip, postGapMs: postGap });
      if (res.refused) throw new Error(`${p.botId}: ${p.shareId} refused the replay (404)`);
      if (res.failures) log(`  ${p.botId}: ${res.failures} requests failed`);
      done.add(key);
      state.doneVisits.push(key);
      save();
      await pause(pacing);
    }
    if (refused) await refuse(refused);
    state.donePeople.push(p.n);
    save();
    finished += 1;
    if (finished % 10 === 0 || finished === returners.length) log(`  ${finished}/${returners.length} people · ${Math.round((Date.now() - t0) / 1000)}s`);
  };

  // A lifted link is live for anyone; send its returners first and alone, then close it again.
  for (const p of queue.filter((x) => refusedById.has(x.shareId))) await replayPerson(p);
  const rest = queue.filter((x) => !refusedById.has(x.shareId));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const p = rest.shift();
        if (!p) return;
        await replayPerson(p);
      }
    }),
  );

  log("waiting 5s for the ingest to drain, then checking rows");
  await new Promise((r) => setTimeout(r, 5000));
  for (const p of returners) {
    let problem: string | null = "unchecked";
    for (let attempt = 0; attempt < 10 && problem; attempt++) {
      const rows = await rowsOf(db, p);
      problem = rows.length !== p.visits.length ? `${rows.length} visit rows, planned ${p.visits.length}` : await viewMatchesRows(db, p);
      if (problem) await new Promise((r) => setTimeout(r, 3000));
    }
    if (problem) throw new Error(`${p.botId}: ${problem}; not backdating (rerun to resume)`);
  }

  const report: Record<string, number> = {};
  const count = (k: string, n: number) => (report[k] = (report[k] ?? 0) + n);
  await backdateViewers({ db, plan, people: returners, count });

  const eventOps: mongoose.mongo.AnyBulkWriteOperation[] = [];
  for (const p of returners.filter((x) => x.download)) {
    eventOps.push({
      updateMany: {
        filter: { docId: new Types.ObjectId(p.docId), type: "share.downloaded", "meta.shareId": p.shareId, "meta.viewerKey": sha256(p.botId) },
        update: { $set: { createdDate: new Date(p.download!.atMs) } },
      },
    });
  }
  if (eventOps.length) count("activityevents", (await db.collection("activityevents").bulkWrite(eventOps, { ordered: false })).modifiedCount);

  // The ingest stamps updatedDate on every link and doc it touches; this was maintenance, not traffic.
  // Docs are restored below, after the rollup.
  for (const [shareId, at] of Object.entries(state.linkUpdatedDate)) {
    await db.collection("sharelinks").updateOne({ shareId }, { $set: { updatedDate: at ? new Date(at) : null } });
  }

  // Again after the updatedDate restore, and for any link whose planned refusal moved with its returners.
  const manifestRefused = new Map(traffic.refused.map((r) => [r.shareId, r]));
  for (const r of plan.refused) {
    if (!state.lifted[r.shareId] && manifestRefused.get(r.shareId)?.disableAt === iso(r.disableAt)) continue;
    count(`links ${r.kind}`, await refuse(r));
  }

  const reconciled = await reconcileShareLinkCounters({ orgId: manifest.orgId });
  count("links reconciled", reconciled.linksReconciled);
  for (const docId of new Set(returners.map((p) => p.docId))) await rollupDocMetrics({ docId });
  // After the rollup, whose snapshot write stamps updatedDate too.
  for (const [docId, at] of Object.entries(state.docUpdatedDate)) {
    await db.collection("docs").updateOne({ _id: new Types.ObjectId(docId) }, { $set: { updatedDate: at ? new Date(at) : null } });
  }

  // Manifest and progress follow the rows.
  for (const p of returners) {
    const m = sent.get(p.n)!;
    m.visits = p.visits.map((v) => ({ visitId: v.visitId, visitIdHash: sha256(v.visitId), startAt: iso(v.startAt), endAt: iso(v.endAt) }));
    m.download = p.download ? iso(p.download.atMs) : null;
  }
  traffic.refused = plan.refused.map((r) => ({ ...r, maxEnd: iso(r.maxEnd), disableAt: iso(r.disableAt) }));
  writeManifest(manifest);
  const progressFile = path.join(SEED_DIR, tag, "progress.json");
  if (fs.existsSync(progressFile)) {
    const progress = JSON.parse(fs.readFileSync(progressFile, "utf8")) as { startedVisits: string[]; doneVisits: string[] };
    const started = new Set(progress.startedVisits);
    const doneKeys = new Set(progress.doneVisits);
    for (const p of returners) {
      for (const v of p.visits) {
        const key = visitKey(p, v);
        if (!started.has(key)) progress.startedVisits.push(key);
        if (!doneKeys.has(key)) progress.doneVisits.push(key);
      }
    }
    writeJsonAtomic(progressFile, progress);
  }

  state.finishedAt = iso(Date.now());
  save();
  log(`backdate: ${Object.entries(report).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  log(`done: ${returners.length} returners replayed in ${Math.round((Date.now() - t0) / MINUTE)} min; manifest updated`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
