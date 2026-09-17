/**
 * Readers for the seed corpus: plan (seed-corpus/plan.ts), send through the public ingest in lanes,
 * backdate with the fix-up, then send a small live tail that is left at real time.
 *
 * Run:
 *   EMAIL_TRANSPORT=console npx tsx --env-file=.env.local tests/share/traffic-corpus.ts --tag <TAG>
 *     [--seed 42] [--lanes 6] [--pace 0.3-1.2] [--post-gap 150-250] [--dry-run] [--live-only]
 *
 * Resumable: tests/share/.seed/<TAG>/progress.json records every visit started and finished. A visit
 * that was started but not finished is skipped on resume rather than sent twice.
 *
 * Readers never use request-to-download (it emails the owner); they only GET the PDF on links that
 * allow downloads. `--live-only` adds another live batch and re-reads link state from Mongo first, so
 * no live reader lands on a link that was disabled or expired.
 */
import fs from "node:fs";
import path from "node:path";

import mongoose, { Types } from "mongoose";
import { encode } from "next-auth/jwt";

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
  type ManifestDoc,
  type ManifestPerson,
} from "./seed-corpus/api";
import { DOC_SPECS } from "./seed-corpus/content";
import { runFixup, sha256 } from "./seed-corpus/fixup";
import {
  ARCHETYPE_SHARES,
  buildPlan,
  isLinkActiveAt,
  MINUTE,
  pickLiveLink,
  planLiveTail,
  rngFor,
  type Archetype,
  type LinkState,
  type Plan,
  type PlannedPerson,
} from "./seed-corpus/plan";
import { compilePerson, compileVisit, sendRequests } from "./seed-corpus/wire";
import { connectMongo } from "@/lib/mongodb";

assertConsoleEmail();

type Progress = {
  tag: string;
  seed: number;
  runStart: number;
  startedVisits: string[];
  doneVisits: string[];
  doneDownloads: string[];
  refusedPeople: number[];
  bulkDone: boolean;
  fixupAt: string | null;
  liveBatches: number[];
};

function log(s = ""): void {
  console.log(s);
}

function parseRange(raw: string, name: string): [number, number] {
  const [a, b] = raw.split("-").map(Number);
  const lo = a ?? NaN;
  const hi = b ?? lo;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) throw new Error(`--${name} expects <min>-<max>, got "${raw}"`);
  return [lo, hi];
}

const iso = (ms: number) => new Date(ms).toISOString();
const progressPath = (tag: string) => path.join(SEED_DIR, tag, "progress.json");

function readProgress(tag: string): Progress | null {
  const file = progressPath(tag);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Progress) : null;
}

/** Docs for a dry run without a manifest: the content specs with placeholder ids. */
function placeholderDocs(): ManifestDoc[] {
  return DOC_SPECS.map((s, i) => ({
    slug: s.slug,
    docId: (i + 1).toString(16).padStart(24, "0"),
    uploadId: null,
    pages: s.pages.map((p) => p.role),
    links: [
      { shareId: `dry${String(i).padStart(2, "0")}default`, label: "Default link", isDefault: true, allowDownload: false },
      ...s.links.map((l, k) => ({ shareId: `dry${String(i).padStart(2, "0")}link${k}`, label: l.label, isDefault: false, allowDownload: l.allowDownload })),
    ],
  }));
}

function planFor(manifest: Pick<Manifest, "tag" | "docs">, seed: number, runStart: number): Plan {
  return buildPlan({
    tag: manifest.tag,
    seed,
    runStart,
    docs: manifest.docs.map((d) => ({ slug: d.slug, docId: d.docId, pages: d.pages, links: d.links })),
    smoke: manifest.docs.length < 50,
  });
}

function toManifestPerson(p: PlannedPerson, status: ManifestPerson["status"]): ManifestPerson {
  return {
    n: p.n,
    botId: p.botId,
    botIdHash: sha256(p.botId),
    docId: p.docId,
    shareId: p.shareId,
    archetype: p.archetype,
    live: p.live,
    batch: p.batch,
    status,
    visits: p.visits.map((v) => ({ visitId: v.visitId, visitIdHash: sha256(v.visitId), startAt: iso(v.startAt), endAt: iso(v.endAt) })),
    download: p.download ? iso(p.download.atMs) : null,
  };
}

function printDryRun(plan: Plan, opts: { postGap: [number, number]; pacing: Pacing; lanes: number }): void {
  const byId = new Map(plan.docs.map((d) => [d.docId, d]));
  const everyone = [...plan.people, ...plan.ownerPreviews, ...plan.live];
  let posts = 0;
  let gets = 0;
  let visits = 0;
  for (const p of everyone) {
    visits += p.visits.length;
    for (const reqs of compilePerson(p, byId.get(p.docId)!.pageCount)) for (const r of reqs) {
      if (r.method === "GET") gets += 1;
      else posts += 1;
    }
  }
  log(`plan: seed ${plan.seed}, runStart ${iso(plan.runStart)}${plan.smoke ? ", smoke profile" : ""}`);
  log(`  ${plan.docs.length} docs, ${plan.people.length} people, ${plan.ownerPreviews.length} owner previews, ${plan.live.length} live-tail people`);
  log(`  ${visits} visits, ${posts} stats POSTs, ${gets} download GETs`);
  const secs = (posts * ((opts.postGap[0] + opts.postGap[1]) / 2) + (opts.pacing.enabled ? visits * ((opts.pacing.minMs + opts.pacing.maxMs) / 2) : 0)) / 1000 / opts.lanes;
  log(`  estimated bulk send time with ${opts.lanes} lanes: ~${Math.round(secs / 60)} min`);

  const buckets = new Map<string, number>();
  for (const d of plan.docs) buckets.set(d.bucket, (buckets.get(d.bucket) ?? 0) + 1);
  log(`  people buckets (docs): ${[...buckets.entries()].map(([b, n]) => `${b}: ${n}`).join(" · ")}`);

  log("archetype shares (bulk people):");
  for (const a of Object.keys(ARCHETYPE_SHARES) as Archetype[]) {
    const n = plan.people.filter((p) => p.archetype === a).length;
    log(`  ${a.padEnd(9)} ${String(n).padStart(4)}  ${((n / Math.max(1, plan.people.length)) * 100).toFixed(1)}%  (target ${(ARCHETYPE_SHARES[a] * 100).toFixed(0)}%)`);
  }
  const allVisits = plan.people.flatMap((p) => p.visits);
  log(
    `injections: ${allVisits.filter((v) => v.hiddenSplit).length} hidden splits, ${allVisits.filter((v) => v.idle).length} idle, ${allVisits.filter((v) => v.killed).length} killed tabs; ` +
      `${plan.people.filter((p) => p.intro).length} introductions, ${plan.people.filter((p) => p.download).length} downloads`,
  );

  log(`refused links (${plan.refused.length}):`);
  const limit = plan.runStart - MINUTE;
  for (const r of plan.refused) {
    const people = plan.people.filter((p) => p.shareId === r.shareId).length;
    log(
      `  ${r.kind.padEnd(8)} ${r.shareId}  "${r.label}"  people ${people}  lastVisitEnd ${iso(r.maxEnd)}  disableAt ${iso(r.disableAt)}  ≤ runStart-1min: ${r.disableAt <= limit ? "yes" : "NO"}`,
    );
  }
  const refused = new Set(plan.refusedShareIds);
  log(`live tail (${plan.live.length}):`);
  for (const p of plan.live) {
    const link = byId.get(p.docId)!.links.find((l) => l.shareId === p.shareId)!;
    log(
      `  ${p.botId}  ${p.slug}  "${p.linkLabel}"  ${p.archetype}  ends ${Math.round(p.endsAgoMs! / 1000)}s before send  refused: ${refused.has(p.shareId) ? "YES" : "no"}  active: ${isLinkActiveAt(link, plan.runStart) ? "yes" : "NO"}`,
    );
  }
  for (const s of plan.skipped) log(s);

  const sample = plan.people.find((p) => p.archetype === "reader" && !p.visits[0]!.killed && p.visits[0]!.stops.length >= 4) ?? plan.people[0];
  if (sample) {
    const v = sample.visits[0]!;
    const { requests } = compileVisit(v, { botId: sample.botId, shareId: sample.shareId, numPages: byId.get(sample.docId)!.pageCount, intro: sample.intro });
    const reasons = [...new Set(requests.map((r) => r.body?.reason).filter(Boolean))];
    log(`sample visit: ${sample.archetype} on ${sample.slug} via "${sample.linkLabel}", ${v.stops.length} stops, ${requests.length} POSTs, reasons ${reasons.join("/")}`);
    const show = [...requests.slice(0, 4), ...requests.slice(-2)];
    for (const r of show) log(`  ${iso(r.atMs)} POST ${r.path} ${JSON.stringify(r.body)}`);
  }
  log();
  log("dry run: no requests sent, no database writes.");
}

async function ownerCookie(db: mongoose.mongo.Db, userId: string, orgId: string): Promise<string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set (run with --env-file=.env.local)");
  const user = await db.collection("users").findOne({ _id: new Types.ObjectId(userId) }, { projection: { name: 1, email: 1, role: 1 } });
  if (!user) throw new Error(`owner user ${userId} not found`);
  const jwt = await encode({
    token: { name: user.name, email: user.email, sub: userId, userId, role: user.role ?? "user", activeOrgId: orgId },
    secret,
    maxAge: 6 * 60 * 60,
  });
  return `next-auth.session-token=${jwt}`;
}

async function readLinkState(db: mongoose.mongo.Db, docIds: string[]): Promise<LinkState> {
  const rows = await db
    .collection("sharelinks")
    .find({ docId: { $in: docIds.map((id) => new Types.ObjectId(id)) } }, { projection: { shareId: 1, enabled: 1, archivedAt: 1, expiresAt: 1 } })
    .toArray();
  const out: LinkState = {};
  for (const r of rows) {
    out[String(r.shareId)] = {
      enabled: r.enabled !== false,
      archivedAt: r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    };
  }
  return out;
}

async function main(): Promise<void> {
  const tag = assertTag(arg("tag"));
  const dryRun = process.argv.includes("--dry-run");
  const liveOnly = process.argv.includes("--live-only");
  const seed = Number(arg("seed") ?? 42);
  if (!Number.isInteger(seed)) throw new Error("--seed expects an integer");
  const lanes = Math.max(1, Math.min(16, Number(arg("lanes") ?? 6)));
  const postGap = parseRange(arg("post-gap") ?? "150-250", "post-gap");
  if (!process.argv.includes("--pace") && !process.argv.includes("--fast")) process.argv.push("--pace", "0.3-1.2");
  const pacing = resolvePacing();
  const livePacing: Pacing = { enabled: true, minMs: 1500, maxMs: 5000 };

  let manifest = readManifest(tag);
  if (!manifest) {
    if (!dryRun) throw new Error(`no manifest for ${tag}; run seed-corpus.ts --tag ${tag} first`);
    log(`no manifest for ${tag}: planning against the content specs with placeholder ids.`);
    manifest = { tag, orgId: "", userId: "", apiKeyId: null, count: DOC_SPECS.length, createdAt: iso(Date.now()), docs: placeholderDocs(), abandonedDocIds: [] };
  }
  const progress = dryRun ? null : readProgress(tag);
  if (progress && progress.seed !== seed) throw new Error(`progress.json was written with --seed ${progress.seed}; pass the same seed`);
  const runStart =
    progress?.runStart ?? (manifest.traffic ? Date.parse(manifest.traffic.runStart) : Math.floor(Date.now() / MINUTE) * MINUTE);
  const plan = planFor(manifest, seed, runStart);

  if (dryRun) {
    printDryRun(plan, { postGap, pacing, lanes });
    return;
  }

  await waitForServer();
  await connectMongo();
  const db = mongoose.connection.db!;
  const state: Progress = progress ?? {
    tag,
    seed,
    runStart,
    startedVisits: [],
    doneVisits: [],
    doneDownloads: [],
    refusedPeople: [],
    bulkDone: false,
    fixupAt: null,
    liveBatches: [],
  };
  const saveProgress = () => writeJsonAtomic(progressPath(tag), state);
  saveProgress();

  manifest.traffic ??= {
    seed,
    runStart: iso(runStart),
    fixupAt: null,
    refused: plan.refused.map((r) => ({ ...r, maxEnd: iso(r.maxEnd), disableAt: iso(r.disableAt) })),
    refusedShareIds: plan.refusedShareIds,
    people: plan.people.map((p) => toManifestPerson(p, "planned")),
    ownerPreviews: plan.ownerPreviews.map((p) => toManifestPerson(p, "planned")),
    liveBatches: [],
    skipped: plan.skipped,
  };
  const traffic = manifest.traffic;
  const m = manifest;
  writeManifest(m);
  for (const s of plan.skipped) log(s);

  if (liveOnly) {
    if (!state.fixupAt && !traffic.fixupAt) throw new Error("--live-only needs a finished bulk run and fix-up first");
    const batch = Math.max(0, ...state.liveBatches, ...traffic.liveBatches) + 1;
    const now = Date.now();
    const linkState = await readLinkState(db, plan.docs.map((d) => d.docId));
    const refusedIds = [...new Set([...plan.refusedShareIds, ...traffic.refusedShareIds])];
    const { people, skipped } = planLiveTail({ ...plan, refusedShareIds: refusedIds }, { batch, now, linkState });
    if (skipped) log(skipped);
    await sendLive({ db, plan, people, batch, refusedIds, manifest: m, pacing: livePacing, postGap, saveProgress, state });
    return;
  }

  log(`bulk: ${plan.people.length} people + ${plan.ownerPreviews.length} owner previews · ${lanes} lanes · ${describePacing(pacing)} between visits`);
  if (!state.bulkDone) {
    const cookie = plan.ownerPreviews.length ? await ownerCookie(db, m.userId, m.orgId) : null;
    await sendBulk({ plan, state, saveProgress, manifest: m, lanes, pacing, postGap, cookie });
    state.bulkDone = true;
    saveProgress();
  }

  if (!state.fixupAt) {
    log("waiting 5s for the ingest to drain, then fixing up timestamps");
    await new Promise((r) => setTimeout(r, 5000));
    const report = await runFixup({ db, plan, specsBySlug: new Map(DOC_SPECS.map((s) => [s.slug, s])), orgId: m.orgId, tag, log });
    state.fixupAt = iso(Date.now());
    traffic.fixupAt = state.fixupAt;
    saveProgress();
    writeManifest(m);
    log(`fix-up: ${Object.entries(report).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }

  if (!state.liveBatches.includes(0) && plan.live.length) {
    await sendLive({ db, plan, people: plan.live, batch: 0, refusedIds: plan.refusedShareIds, manifest: m, pacing: livePacing, postGap, saveProgress, state });
  }

  const sent = traffic.people.filter((p) => p.status === "sent").length;
  const refusedCount = traffic.people.filter((p) => p.status === "refused").length;
  log();
  log(`done: ${sent} people sent, ${refusedCount} refused; manifest ${path.relative(process.cwd(), path.join(SEED_DIR, tag, "manifest.json"))}`);
}

async function sendBulk(a: {
  plan: Plan;
  state: Progress;
  saveProgress: () => void;
  manifest: Manifest;
  lanes: number;
  pacing: Pacing;
  postGap: [number, number];
  cookie: string | null;
}): Promise<void> {
  const { plan, state } = a;
  const byId = new Map(plan.docs.map((d) => [d.docId, d]));
  const started = new Set(state.startedVisits);
  const done = new Set(state.doneVisits);
  const downloads = new Set(state.doneDownloads);
  const refusedPeople = new Set(state.refusedPeople);
  const traffic = a.manifest.traffic!;
  const manifestPeople = new Map([...traffic.people, ...traffic.ownerPreviews].map((p) => [p.n, p]));
  const queue = [...plan.people, ...plan.ownerPreviews].sort((x, y) => x.visits[0]!.startAt - y.visits[0]!.startAt || x.n - y.n);
  const total = queue.length;
  const t0 = Date.now();
  let finished = 0;
  let posts = 0;
  let interrupted = 0;

  const markStatus = (p: PlannedPerson, status: ManifestPerson["status"]) => {
    const row = manifestPeople.get(p.n);
    if (row) row.status = status;
  };

  const worker = async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      const opts = { ip: p.ip, cookie: p.ownerPreview ? a.cookie : null, postGapMs: a.postGap };
      const pageCount = byId.get(p.docId)!.pageCount;
      let refused = refusedPeople.has(p.n);
      for (const v of p.visits) {
        if (refused) break;
        const key = `${p.n}.${v.visitId.slice(v.visitId.lastIndexOf("_") + 1)}`;
        if (done.has(key)) continue;
        if (started.has(key)) {
          interrupted += 1;
          continue;
        }
        started.add(key);
        state.startedVisits.push(key);
        a.saveProgress();
        const { requests } = compileVisit(v, { botId: p.botId, shareId: p.shareId, numPages: pageCount, intro: p.intro });
        const res = await sendRequests(requests, opts);
        posts += res.sent;
        if (res.failures) log(`  ${p.botId}: ${res.failures} requests failed`);
        if (res.refused) {
          refused = true;
          refusedPeople.add(p.n);
          state.refusedPeople.push(p.n);
          log(`  ${p.botId}: link ${p.shareId} refused the first POST (404)`);
        }
        done.add(key);
        state.doneVisits.push(key);
        a.saveProgress();
        await pause(a.pacing);
      }
      if (p.download && !refused && !downloads.has(p.botId)) {
        await sendRequests(compilePerson(p, pageCount).at(-1)!, opts);
        downloads.add(p.botId);
        state.doneDownloads.push(p.botId);
        a.saveProgress();
      }
      markStatus(p, refused ? "refused" : "sent");
      finished += 1;
      if (finished % 25 === 0 || finished === total) {
        writeManifest(a.manifest);
        log(`  ${finished}/${total} people · ${posts} POSTs this session · ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
  };
  await Promise.all(Array.from({ length: a.lanes }, worker));
  writeManifest(a.manifest);
  if (interrupted) log(`  ${interrupted} visits were interrupted by an earlier run and not resent`);
}

async function sendLive(a: {
  db: mongoose.mongo.Db;
  plan: Plan;
  people: PlannedPerson[];
  batch: number;
  refusedIds: string[];
  manifest: Manifest;
  pacing: Pacing;
  postGap: [number, number];
  saveProgress: () => void;
  state: Progress;
}): Promise<void> {
  const traffic = a.manifest.traffic!;
  const byId = new Map(a.plan.docs.map((d) => [d.docId, d]));
  const refused = new Set(a.refusedIds);
  log(`live tail batch ${a.batch}: ${a.people.length} people, ${describePacing(a.pacing)}`);
  let linkState = await readLinkState(a.db, a.plan.docs.map((d) => d.docId));
  let sent = 0;
  for (let i = 0; i < a.people.length; i++) {
    const p = { ...a.people[i]! };
    const doc = byId.get(p.docId)!;
    const current = linkState[p.shareId];
    if (!current || !isLinkActiveAt(current, Date.now()) || current.expiresAt) {
      const pick = pickLiveLink(rngFor(a.plan.seed, `live-repick:${a.batch}:${p.n}`), doc, refused, Date.now(), linkState);
      if (!pick) {
        log(`  ${p.botId}: no active link left on ${doc.slug}; not sent`);
        traffic.people.push(toManifestPerson(p, "refused"));
        continue;
      }
      log(`  ${p.botId}: ${p.shareId} is no longer active; re-picked ${pick.shareId}`);
      p.shareId = pick.shareId;
      p.linkLabel = pick.label;
    }
    const v = p.visits[0]!;
    const startAt = Date.now() - (p.endsAgoMs ?? 0) - v.durationMs;
    const visit = { ...v, startAt, endAt: startAt + v.durationMs };
    p.visits = [visit];
    const { requests } = compileVisit(visit, { botId: p.botId, shareId: p.shareId, numPages: doc.pageCount, intro: p.intro });
    const res = await sendRequests(requests, { ip: p.ip, postGapMs: a.postGap });
    const status = res.refused ? "refused" : "sent";
    if (res.refused) log(`  ${p.botId}: ${p.shareId} answered 404; recorded as refused`);
    else sent += 1;
    traffic.people.push(toManifestPerson(p, status));
    writeManifest(a.manifest);
    if (i < a.people.length - 1) await pause(a.pacing);
    linkState = await readLinkState(a.db, a.plan.docs.map((d) => d.docId));
  }
  traffic.liveBatches.push(a.batch);
  a.state.liveBatches.push(a.batch);
  a.saveProgress();
  writeManifest(a.manifest);
  log(`live tail batch ${a.batch}: ${sent}/${a.people.length} sent`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
