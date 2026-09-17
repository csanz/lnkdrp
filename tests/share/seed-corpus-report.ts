/**
 * Gating report for a seeded corpus: checks the owner analytics endpoints against the manifest and
 * against an independent recomputation from raw Mongo rows. Read-only.
 *
 * Run:
 *   EMAIL_TRANSPORT=console npx tsx --env-file=.env.local tests/share/seed-corpus-report.ts --tag <TAG> --cookie <session token>
 *     [--days 30] [--skip-verify]
 *
 * Gates (exit 1 when any fails):
 *   G1  50 tagged documents, each with exactly one upload, completed, and slideNodes = spec pages
 *   G2  5-10 non-default tagged links per document
 *   G3  /pages people === /shareviews viewerCount === manifest people with status "sent"
 *   G4  spec §8 invariants 2-6 and 10-13 on /pages?matrix=all (13b against /shareviews)
 *   G5  people, totalMs and the page table recomputed here from raw rows equal the API
 *   G6  the person endpoint agrees with the matrix for 3 people on every doc with 5+ people
 *   G7  timeline sanity of seeded visits, refused links, live people only on active links
 *   G8  no charged credits on tagged documents
 *   G9  `npm run verify:analytics` exits 0
 *   G10 no download requests and no doc changes on tagged documents (email safety)
 * Everything under "advisory" is printed only.
 *
 * The recomputation deliberately does not import src/lib/analytics/reading: it re-implements the
 * rules from the spec, so a shared bug cannot make both sides agree.
 */
import { spawnSync } from "node:child_process";

import mongoose, { Types } from "mongoose";

import { APP_URL, argValue as arg, assertConsoleEmail, assertTag, readManifest, type Manifest, type ManifestPerson } from "./seed-corpus/api";
import { DOC_SPECS } from "./seed-corpus/content";
import { connectMongo } from "@/lib/mongodb";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { DocChangeModel } from "@/lib/models/DocChange";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";

assertConsoleEmail();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const READ_MIN_MS = 2000;
const STOP_CAP_MS = 600_000;
const TYPICAL_MIN = 3;
const CALLOUT_MIN_PEOPLE = 5;
const HIGH_INTEREST = new Set(["pricing", "financials", "ask", "team", "traction", "metrics", "options", "roi", "compliance"]);
const HIGH_HAZARD = new Set(["legal", "appendix", "pricing", "terms", "financials", "options", "ask", "cover"]);

function log(s = ""): void {
  console.log(s);
}

// ---------------------------------------------------------------------------------------------
// Gate bookkeeping
// ---------------------------------------------------------------------------------------------

const GATES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"] as const;
type Gate = (typeof GATES)[number];
const failures = new Map<Gate, string[]>(GATES.map((g) => [g, []]));
const checks = new Map<Gate, number>(GATES.map((g) => [g, 0]));

function check(g: Gate, ok: boolean, detail: () => string): void {
  checks.set(g, (checks.get(g) ?? 0) + 1);
  if (!ok) failures.get(g)!.push(detail());
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

let cookieHeader = "";
const latencies: number[] = [];

async function getJson(path: string, timed = false): Promise<{ status: number; body: Json }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${APP_URL}${path}`, { headers: { cookie: cookieHeader, accept: "application/json" }, cache: "no-store" });
    } catch (err) {
      // The shared dev server is sometimes restarted by another session.
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const text = await res.text();
    if (res.status >= 502 && attempt < 20) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (timed) latencies.push(performance.now() - t0);
    let body: Json = {};
    try {
      body = text ? (JSON.parse(text) as Json) : {};
    } catch {
      body = { error: text.slice(0, 200) };
    }
    return { status: res.status, body };
  }
}

// ---------------------------------------------------------------------------------------------
// Independent recomputation (spec §1, §3.2-3.4)
// ---------------------------------------------------------------------------------------------

function windowStart(days: number, now: number): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (Math.max(1, Math.floor(days)) - 1));
  return d;
}

function msOf(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.floor((s[mid - 1]! + s[mid]!) / 2);
}

type Ev = { page: number; d: number; enter: number; left: number; reason: string | null; toPage: number | null; i: number };
type Visit = {
  visitId: string;
  startedAt: number;
  lastEventAt: number;
  timeSpentMs: number;
  seen: number[];
  timed: boolean;
  dwell: number[];
  exitPage: number | null;
  /** Pages shown after a lost final turn and never timed (spec: killed tab). */
  untimedTail: number[];
  validDurationSum: number;
  tv2: boolean;
};

function inRange(p: unknown, P: number): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= P;
}

function recomputeVisit(row: Json, P: number): Visit {
  const raw: Json[] = Array.isArray(row.pageEvents) ? row.pageEvents : [];
  const evs: Ev[] = [];
  raw.forEach((e, i) => {
    if (!e || !inRange(e.pageNumber, P)) return;
    if (typeof e.durationMs !== "number" || !Number.isFinite(e.durationMs) || e.durationMs <= 0) return;
    const enter = msOf(e.enteredAt);
    const left = msOf(e.leftAt);
    if (enter === null || left === null) return;
    const reason = typeof e.reason === "string" ? e.reason : null;
    const toPage = reason === "turn" && inRange(e.toPage, P) && e.toPage !== e.pageNumber ? e.toPage : null;
    evs.push({ page: e.pageNumber, d: e.durationMs, enter, left, reason, toPage, i });
  });
  evs.sort((a, b) => a.enter - b.enter || a.left - b.left || a.i - b.i);
  const dwell = new Array<number>(P).fill(0);
  let curPage = -1;
  let curSum = 0;
  let prevReason: string | null = null;
  const flush = () => {
    if (curPage > 0) dwell[curPage - 1] += Math.min(STOP_CAP_MS, curSum);
  };
  for (const e of evs) {
    if (curPage === e.page && prevReason !== "turn") curSum += e.d;
    else {
      flush();
      curPage = e.page;
      curSum = e.d;
    }
    prevReason = e.reason;
  }
  flush();
  const seen = new Set<number>();
  for (const p of Array.isArray(row.pagesSeen) ? row.pagesSeen : []) if (inRange(p, P)) seen.add(p);
  for (const e of evs) seen.add(e.page);
  const seenArr = [...seen].sort((a, b) => a - b);
  const startedAt = msOf(row.startedAt) ?? 0;
  const lastEventAt = msOf(row.lastEventAt) ?? startedAt;
  let exitPage: number | null = null;
  let untimedTail: number[] = [];
  if (evs.length) {
    let best = evs[0]!;
    for (const e of evs) if (e.left >= best.left) best = e;
    exitPage = best.page;
    // Last timed event is a turn (the tab died before its final flush): they landed on its target, and
    // pages seen after it with no timed event, and no other turn landing there, were flipped to later.
    if (best.toPage !== null && seen.has(best.toPage)) {
      const target = best.toPage;
      const timedPages = new Set(evs.map((e) => e.page));
      const otherTargets = new Set(evs.filter((e) => e !== best).map((e) => e.toPage));
      untimedTail = seenArr.filter((p) => p === target || (p > target && !timedPages.has(p) && !otherTargets.has(p)));
      exitPage = lastEventAt > best.left ? untimedTail[untimedTail.length - 1]! : target;
    }
  } else if (seenArr.length) exitPage = seenArr[seenArr.length - 1]!;
  const ts = typeof row.timeSpentMs === "number" && Number.isFinite(row.timeSpentMs) && row.timeSpentMs > 0 ? row.timeSpentMs : 0;
  return {
    visitId: String(row._id),
    startedAt,
    lastEventAt,
    timeSpentMs: ts,
    seen: seenArr,
    timed: evs.length > 0,
    dwell,
    exitPage,
    untimedTail,
    validDurationSum: evs.reduce((a, e) => a + e.d, 0),
    tv2: row.timingVersion === 2,
  };
}

type State = "read" | "passed" | "unknown" | "jumped" | "unreached";
type RPerson = {
  key: string;
  personId: string;
  botIdHash: string | null;
  visits: Visit[];
  seen: Set<number>;
  maxPage: number;
  timed: boolean;
  dwell: number[];
  totalMs: number;
  exitPage: number | null;
  states: State[];
  hasDetail: boolean;
};
type RPage = { page: number; reached: number; readCount: number; typicalMs: number | null; passed: number; leftHere: number; stillReading: number };
type Recomputed = { people: RPerson[]; totalMs: number; peopleWithDetail: number; pages: RPage[]; unmatched: number };

async function recompute(db: mongoose.mongo.Db, docId: Types.ObjectId, P: number, days: number, now: number): Promise<Recomputed> {
  const start = windowStart(days, now);
  const recipient = { isOwnerPreview: { $ne: true } };
  const [rows, visitRows] = await Promise.all([
    db
      .collection("shareviews")
      .find({ docId, ...recipient, $or: [{ lastViewedAt: { $gte: start } }, { lastViewedAt: null, updatedDate: { $gte: start } }] })
      .toArray(),
    db.collection("sharevisits").find({ docId, ...recipient, lastEventAt: { $gte: start } }).toArray(),
  ]);
  const byKey = new Map<string, RPerson>();
  const keyByShareBot = new Map<string, string>();
  for (const r of rows) {
    const shareId = String(r.shareId);
    const user = r.viewerUserId ? String(r.viewerUserId) : null;
    const key = user ? `${shareId}|u:${user}` : `${shareId}|a:${String(r.botIdHash)}`;
    const personId = user ? `${shareId}.u.${user}` : `${shareId}.a.${String(r.botIdHash)}`;
    keyByShareBot.set(`${shareId}|${String(r.botIdHash)}`, key);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        personId,
        botIdHash: user ? null : String(r.botIdHash),
        visits: [],
        seen: new Set(),
        maxPage: 0,
        timed: false,
        dwell: new Array<number>(P).fill(0),
        totalMs: 0,
        exitPage: null,
        states: [],
        hasDetail: false,
      });
    }
  }
  let unmatched = 0;
  for (const v of visitRows) {
    const key = keyByShareBot.get(`${String(v.shareId)}|${String(v.botIdHash)}`);
    if (!key) {
      unmatched += 1;
      continue;
    }
    byKey.get(key)!.visits.push(recomputeVisit(v, P));
  }
  const people = [...byKey.values()];
  for (const p of people) {
    let latest: Visit | null = null;
    const untimedTail = new Set<number>();
    for (const v of p.visits) {
      for (const t of v.untimedTail) untimedTail.add(t);
      p.totalMs += v.timeSpentMs;
      p.timed ||= v.timed;
      for (const s of v.seen) p.seen.add(s);
      for (let i = 0; i < P; i++) p.dwell[i] += v.dwell[i]!;
      if (v.seen.length) {
        const later =
          latest === null ||
          v.lastEventAt > latest.lastEventAt ||
          (v.lastEventAt === latest.lastEventAt && (v.startedAt > latest.startedAt || (v.startedAt === latest.startedAt && v.visitId > latest.visitId)));
        if (later) latest = v;
      }
    }
    p.exitPage = latest?.exitPage ?? null;
    p.maxPage = p.seen.size ? Math.max(...p.seen) : 0;
    p.hasDetail = p.seen.size > 0;
    p.states = Array.from({ length: P }, (_, i) =>
      !p.seen.has(i + 1)
        ? i + 1 < p.maxPage
          ? "jumped"
          : "unreached"
        : !p.timed
          ? "unknown"
          : p.dwell[i]! >= READ_MIN_MS
            ? "read"
            : p.dwell[i] === 0 && untimedTail.has(i + 1)
              ? "unknown"
              : "passed",
    );
  }
  const detail = people.filter((p) => p.hasDetail);
  const pages: RPage[] = Array.from({ length: P }, (_, i) => {
    const page = i + 1;
    const readers = detail.filter((p) => p.states[i] === "read");
    return {
      page,
      reached: detail.filter((p) => p.seen.has(page)).length,
      readCount: readers.length,
      typicalMs: readers.length >= TYPICAL_MIN ? medianOf(readers.map((p) => p.dwell[i]!)) : null,
      passed: detail.filter((p) => p.states[i] === "passed").length,
      leftHere: detail.filter((p) => p.exitPage === page).length,
      stillReading: detail.filter((p) => p.maxPage >= page).length,
    };
  });
  return { people, totalMs: people.reduce((a, p) => a + p.totalMs, 0), peopleWithDetail: detail.length, pages, unmatched };
}

function gateText(people: number, n: number): string | null {
  if (n === 0 || n >= CALLOUT_MIN_PEOPLE) return null;
  return people < CALLOUT_MIN_PEOPLE ? "Page highlights appear once 5 people have opened it." : "Page highlights appear once 5 people have page detail.";
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

type DocOutcome = { slug: string; docId: string; pages: number; people: number; bucket: string; api: Json | null };

async function main(): Promise<void> {
  const tag = assertTag(arg("tag"));
  const rawCookie = arg("cookie") ?? process.env.SEED_OWNER_COOKIE ?? "";
  if (!rawCookie) throw new Error("--cookie <next-auth session token> is required");
  cookieHeader = rawCookie.includes("=") ? rawCookie : `next-auth.session-token=${rawCookie}`;
  const days = Math.max(1, Math.min(365, Number(arg("days") ?? 30)));
  const skipVerify = process.argv.includes("--skip-verify");
  const manifest: Manifest | null = readManifest(tag);
  if (!manifest) throw new Error(`no manifest for ${tag}`);
  const traffic = manifest.traffic;
  if (!traffic) throw new Error(`manifest for ${tag} has no traffic section; run traffic-corpus.ts first`);

  await connectMongo();
  const db = mongoose.connection.db!;
  const specBySlug = new Map(DOC_SPECS.map((s) => [s.slug, s]));
  const plan = await getJson("/api/plan");
  log(`report ${tag}: ${manifest.docs.length} docs in manifest, days ${days}, plan ${plan.body.plan ?? "?"}`);

  const docOids = manifest.docs.map((d) => new Types.ObjectId(d.docId));
  const people = traffic.people;
  const sentByDoc = new Map<string, ManifestPerson[]>();
  for (const p of people) if (p.status === "sent") sentByDoc.set(p.docId, [...(sentByDoc.get(p.docId) ?? []), p]);
  const archetypeByHash = new Map(people.map((p) => [p.botIdHash, p]));

  // G1 / G2 --------------------------------------------------------------------------------
  const taggedDocs = await db.collection("docs").find({ seedTag: tag }, { projection: { _id: 1, slideNodes: 1, status: 1 } }).toArray();
  const abandoned = new Set(manifest.abandonedDocIds);
  const liveTagged = taggedDocs.filter((d) => !abandoned.has(String(d._id)));
  check("G1", manifest.docs.length === 50, () => `manifest has ${manifest.docs.length} docs, expected 50`);
  check("G1", liveTagged.length === 50, () => `${liveTagged.length} tagged non-abandoned docs in Mongo, expected 50`);
  const docRow = new Map(taggedDocs.map((d) => [String(d._id), d]));
  const uploads = await db.collection("uploads").find({ docId: { $in: docOids } }, { projection: { docId: 1, status: 1 } }).toArray();
  const links = await db
    .collection("sharelinks")
    .find({ docId: { $in: docOids } }, { projection: { docId: 1, shareId: 1, isDefault: 1, seedTag: 1, enabled: 1, expiresAt: 1, archivedAt: 1, createdDate: 1, label: 1 } })
    .toArray();
  const linkByShare = new Map(links.map((l) => [String(l.shareId), l]));
  for (const d of manifest.docs) {
    const spec = specBySlug.get(d.slug);
    const row = docRow.get(d.docId);
    check("G1", !!row, () => `${d.slug}: doc ${d.docId} is not tagged ${tag}`);
    const ups = uploads.filter((u) => String(u.docId) === d.docId);
    check("G1", ups.length === 1 && ups[0]!.status === "completed", () => `${d.slug}: uploads ${JSON.stringify(ups.map((u) => u.status))}`);
    const slides = Array.isArray(row?.slideNodes) ? row!.slideNodes.length : -1;
    check("G1", !!spec && slides === spec.pages.length, () => `${d.slug}: slideNodes ${slides}, spec ${spec?.pages.length}`);
    const labelled = links.filter((l) => String(l.docId) === d.docId && !l.isDefault && l.seedTag === tag).length;
    check("G2", labelled >= 5 && labelled <= 10, () => `${d.slug}: ${labelled} non-default tagged links`);
  }

  // Per-doc API checks ------------------------------------------------------------------------
  const outcomes: DocOutcome[] = [];
  const bucketOf = (n: number) => (n === 0 ? "0" : n === 1 ? "1" : n <= 4 ? "2-4" : n <= 15 ? "5-15" : n <= 29 ? "16-29" : "30+");
  let hotByArchetype = new Map<string, { people: number; hot: number }>();
  let activeRowsLive = 0;

  for (const d of manifest.docs) {
    const P = Array.isArray(docRow.get(d.docId)?.slideNodes) ? docRow.get(d.docId)!.slideNodes.length : 0;
    const now = Date.now();
    const pagesRes = await getJson(`/api/docs/${d.docId}/pages?days=${days}&matrix=all`, true);
    const svRes = await getJson(`/api/docs/${d.docId}/shareviews?days=${days}&lite=1`);
    const scope = d.slug;
    if (pagesRes.status !== 200 || svRes.status !== 200) {
      check("G3", false, () => `${scope}: /pages ${pagesRes.status}, /shareviews ${svRes.status}`);
      outcomes.push({ slug: d.slug, docId: d.docId, pages: P, people: -1, bucket: "?", api: null });
      continue;
    }
    const A = pagesRes.body;
    const B = svRes.body;
    const sent = sentByDoc.get(d.docId)?.length ?? 0;
    outcomes.push({ slug: d.slug, docId: d.docId, pages: P, people: A.people, bucket: bucketOf(A.people), api: A });

    // G3
    check("G3", A.people === B.viewerCount && A.people === sent, () => `${scope}: /pages people ${A.people}, viewerCount ${B.viewerCount}, manifest sent ${sent}`);

    // G4: §8 2-6, 10-13
    const N: number = A.peopleWithDetail;
    const linkRows: Json[] = A.links ?? [];
    check("G4", A.tier === "deep", () => `${scope}: tier ${A.tier}`);
    check("G4", linkRows.reduce((a, l) => a + l.people, 0) === A.people, () => `${scope} §8.2: Σ links.people ${linkRows.reduce((a, l) => a + l.people, 0)} ≠ ${A.people}`);
    const pageRows: Json[] = A.pages ?? [];
    check("G4", pageRows.reduce((a, p) => a + p.leftHere, 0) === N, () => `${scope} §8.3: Σ leftHere ≠ peopleWithDetail ${N}`);
    for (const p of pageRows) {
      check(
        "G4",
        p.readCount + p.passed <= p.reached && p.reached <= p.stillReading && p.stillReading <= N && N <= A.people,
        () => `${scope} §8.4 page ${p.page}: ${JSON.stringify(p)} N ${N} people ${A.people}`,
      );
      check("G4", (p.typicalMs === null) === (p.readCount < TYPICAL_MIN), () => `${scope} §8.12 page ${p.page}: typicalMs ${p.typicalMs} readCount ${p.readCount}`);
    }
    const rows: Json[] = A.matrix?.rows ?? [];
    check("G4", A.pageCount === P && pageRows.length === P, () => `${scope} §8.6: pageCount ${A.pageCount}, pages ${pageRows.length}, P ${P}`);
    for (const r of rows) check("G4", r.cells.length === P, () => `${scope} §8.6: ${r.personId} has ${r.cells.length} cells`);
    for (const l of [...linkRows, A]) {
      const label = l === A ? "top" : `link ${l.shareId}`;
      check("G4", l.everOpened === (l.lastOpenedAtAllTime !== null), () => `${scope} §8.10 ${label}: everOpened ${l.everOpened} allTime ${l.lastOpenedAtAllTime}`);
      if (l.people > 0) {
        check("G4", l.everOpened && l.lastOpenedAt === l.lastOpenedAtAllTime, () => `${scope} §8.10 ${label}: lastOpenedAt ${l.lastOpenedAt} ≠ ${l.lastOpenedAtAllTime}`);
      }
    }
    const linkRowById = new Map(linkRows.map((l) => [l.shareId, l]));
    for (const row of (A.attention?.rows ?? []) as Json[]) {
      if (row.kind !== "not_opened") continue;
      check("G4", linkRowById.get(row.shareId)?.everOpened === false, () => `${scope} §8.11: not_opened ${row.shareId} has everOpened ${linkRowById.get(row.shareId)?.everOpened}`);
    }
    if (A.matrix && A.matrix.total <= 500) {
      const sum = rows.reduce((a, r) => a + r.totalMs, 0);
      check("G4", A.totalMs >= sum, () => `${scope} §8.13a: totalMs ${A.totalMs} < Σ rows ${sum}`);
    }
    if (A.coverage && A.coverage.unmatchedVisits === 0 && !A.coverage.truncated) {
      check("G4", A.totalMs === B.totals?.visitTimeMs, () => `${scope} §8.13b: totalMs ${A.totalMs} ≠ visitTimeMs ${B.totals?.visitTimeMs}`);
    }
    check("G4", A.calloutGate === gateText(A.people, N), () => `${scope} §8.13c: calloutGate ${JSON.stringify(A.calloutGate)}`);
    check("G4", (A.callouts === null) === (N < CALLOUT_MIN_PEOPLE), () => `${scope} §8.13c: callouts ${A.callouts === null ? "null" : "set"} with N ${N}`);

    // G5 (+ §8.5 which needs raw rows)
    const R = await recompute(db, new Types.ObjectId(d.docId), P, days, now);
    check("G5", R.people.length === A.people, () => `${scope}: recomputed people ${R.people.length} ≠ ${A.people}`);
    check("G5", R.totalMs === A.totalMs, () => `${scope}: recomputed totalMs ${R.totalMs} ≠ ${A.totalMs}`);
    check("G5", R.peopleWithDetail === N, () => `${scope}: recomputed peopleWithDetail ${R.peopleWithDetail} ≠ ${N}`);
    check("G5", R.unmatched === (A.coverage?.unmatchedVisits ?? 0), () => `${scope}: recomputed unmatched ${R.unmatched} ≠ ${A.coverage?.unmatchedVisits}`);
    for (const rp of R.pages) {
      const ap = pageRows[rp.page - 1];
      const fields = ["reached", "readCount", "typicalMs", "passed", "leftHere", "stillReading"] as const;
      const diff = ap ? fields.filter((f) => ap[f] !== rp[f]) : ["missing"];
      check("G5", !!ap && ap.page === rp.page && diff.length === 0, () => `${scope} page ${rp.page}: ${diff.map((f) => `${f} api ${ap?.[f]} vs ${(rp as Json)[f]}`).join(", ")}`);
    }
    const rowById = new Map(rows.map((r) => [r.personId, r]));
    for (const rp of R.people) {
      for (const v of rp.visits) {
        if (v.tv2) check("G4", v.validDurationSum <= v.timeSpentMs + 1000, () => `${scope} §8.5: visit ${v.visitId} page ms ${v.validDurationSum} > ${v.timeSpentMs} + 1000`);
      }
      const mr = rowById.get(rp.personId);
      if (rp.hasDetail) check("G5", !!mr, () => `${scope}: person ${rp.personId} missing from matrix`);
      if (mr && rp.visits.length && rp.visits.every((v) => v.tv2)) {
        const cellSum = (mr.cells as Json[]).reduce((a, c) => a + c.ms, 0);
        check("G4", cellSum <= mr.totalMs + 1000 * rp.visits.length, () => `${scope} §8.5: ${rp.personId} cells ${cellSum} > ${mr.totalMs} + 1000×${rp.visits.length}`);
      }
      if (mr) {
        const cellDiff = rp.states.findIndex((s, i) => mr.cells[i]?.state !== s || mr.cells[i]?.ms !== rp.dwell[i]);
        check("G5", cellDiff === -1 && mr.totalMs === rp.totalMs && mr.exitPage === rp.exitPage, () => `${scope}: matrix row ${rp.personId} differs (cell ${cellDiff + 1}, totalMs ${mr.totalMs}/${rp.totalMs}, exit ${mr.exitPage}/${rp.exitPage})`);
      }
    }

    // G6
    if (A.people >= 5 && rows.length) {
      const picks = [...new Set([0, rows.length >> 1, rows.length - 1])].map((i) => rows[i]!);
      for (const r of picks) {
        const pr = await getJson(`/api/docs/${d.docId}/pages/person?id=${encodeURIComponent(r.personId)}&days=${days}`);
        if (pr.status !== 200) {
          check("G6", false, () => `${scope}: person ${r.personId} → ${pr.status}`);
          continue;
        }
        const b = pr.body;
        const msDiff = (b.pages as Json[]).filter((p, i) => p.ms !== r.cells[i]?.ms).map((p) => p.page);
        check(
          "G6",
          b.pages.length === P && msDiff.length === 0 && b.facts.reachedCount === r.reachedCount && b.facts.exitPage === r.exitPage && b.facts.totalMs === r.totalMs,
          () => `${scope}: person ${r.personId} vs matrix: pages ${b.pages.length}/${P} ms differ on ${msDiff.join(",")} reached ${b.facts.reachedCount}/${r.reachedCount} exit ${b.facts.exitPage}/${r.exitPage} total ${b.facts.totalMs}/${r.totalMs}`,
        );
      }
    }

    // Advisory tallies
    for (const r of rows) {
      const hash = String(r.personId).split(".")[2] ?? "";
      const mp = archetypeByHash.get(hash);
      if (!mp) continue;
      const t = hotByArchetype.get(mp.archetype) ?? { people: 0, hot: 0 };
      t.people += 1;
      if (r.hot) t.hot += 1;
      hotByArchetype.set(mp.archetype, t);
    }
    if ((A.attention?.rows ?? []).some((r: Json) => r.kind === "active")) activeRowsLive += 1;
  }
  hotByArchetype = new Map([...hotByArchetype.entries()].sort());

  // G7 -------------------------------------------------------------------------------------
  const fixupAt = traffic.fixupAt ? Date.parse(traffic.fixupAt) : null;
  check("G7", fixupAt !== null, () => "manifest traffic.fixupAt is missing");
  const visits = await db
    .collection("sharevisits")
    .find({ docId: { $in: docOids } }, { projection: { shareId: 1, startedAt: 1, lastEventAt: 1, botIdHash: 1 } })
    .toArray();
  const plannedEnds = [...people, ...traffic.ownerPreviews].flatMap((p) => [...p.visits.map((v) => Date.parse(v.endAt)), p.download ? Date.parse(p.download) : NaN]);
  const runEnd = Math.max(...plannedEnds.filter(Number.isFinite), Date.parse(traffic.runStart));
  const upper = runEnd + 10 * 60_000;
  log(`G7 bound: lastEventAt ≤ ${new Date(upper).toISOString()} (latest planned visit end + 10min)`);
  let badTimeline = 0;
  for (const v of visits) {
    const link = linkByShare.get(String(v.shareId));
    const start = msOf(v.startedAt) ?? NaN;
    const last = msOf(v.lastEventAt) ?? NaN;
    const created = msOf(link?.createdDate) ?? NaN;
    const ok = !!link && last >= created - 1000 && start <= last && last <= upper;
    if (!ok) badTimeline += 1;
    check("G7", ok, () => `visit ${String(v._id)} on ${String(v.shareId)}: startedAt ${new Date(start).toISOString()} lastEventAt ${new Date(last).toISOString()} link created ${link ? new Date(created).toISOString() : "missing"}`);
  }
  for (const r of traffic.refused) {
    const l = linkByShare.get(r.shareId);
    const exp = msOf(l?.expiresAt);
    const ok = !!l && (r.kind === "disabled" ? l.enabled === false : exp !== null && fixupAt !== null && exp <= fixupAt);
    check("G7", ok, () => `refused ${r.kind} link ${r.shareId}: enabled ${l?.enabled} expiresAt ${l?.expiresAt} fixupAt ${traffic.fixupAt}`);
  }
  const refusedIds = new Set(traffic.refusedShareIds);
  for (const p of people.filter((x) => x.live && x.status === "sent")) {
    const l = linkByShare.get(p.shareId);
    const exp = msOf(l?.expiresAt);
    check("G7", !refusedIds.has(p.shareId), () => `live person ${p.botId} was sent on refused link ${p.shareId}`);
    check("G7", !!l && l.enabled !== false && !l.archivedAt && (exp === null || exp > Date.now()), () => `live person ${p.botId} is on inactive link ${p.shareId}`);
  }

  // G8 / G10 -------------------------------------------------------------------------------
  // Names come from the models so a hand-typed name (e.g. "docchanges" vs "docChanges") cannot count 0.
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const countIn = async (name: string, extra: Json = {}) => {
    if (!collections.has(name)) log(`note: collection ${name} does not exist yet; it holds no rows`);
    return db.collection(name).countDocuments({ docId: { $in: docOids }, ...extra });
  };
  const ledgerName = CreditLedgerModel.collection.name;
  const dlrName = ShareDownloadRequestModel.collection.name;
  const changesName = DocChangeModel.collection.name;
  const charged = await countIn(ledgerName, { creditsCharged: { $gt: 0 } });
  check("G8", charged === 0, () => `${charged} ${ledgerName} rows with creditsCharged > 0`);
  const dlr = await countIn(dlrName);
  const changes = await countIn(changesName);
  check("G10", dlr === 0, () => `${dlr} ${dlrName} on tagged docs`);
  check("G10", changes === 0, () => `${changes} ${changesName} on tagged docs`);
  log(`G8/G10 collections: ${ledgerName} ${charged} charged, ${dlrName} ${dlr}, ${changesName} ${changes}`);

  // G9 -------------------------------------------------------------------------------------
  if (skipVerify) {
    log("G9 skipped (--skip-verify)");
  } else {
    const res = spawnSync("npm", ["run", "verify:analytics", "--", "--quiet"], {
      encoding: "utf8",
      env: { ...process.env, EMAIL_TRANSPORT: "console" },
      maxBuffer: 64 * 1024 * 1024,
    });
    const tail = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | ");
    check("G9", res.status === 0, () => `verify:analytics exited ${res.status}: ${tail}`);
    log(`verify:analytics exit ${res.status}: ${tail}`);
  }

  // Output ---------------------------------------------------------------------------------
  log();
  log("gates:");
  let failed = 0;
  for (const g of GATES) {
    const f = failures.get(g)!;
    if (g === "G9" && skipVerify) {
      log(`  ${g.padEnd(4)} SKIP`);
      continue;
    }
    log(`  ${g.padEnd(4)} ${f.length ? "FAIL" : "pass"}  (${checks.get(g)} checks${f.length ? `, ${f.length} failed` : ""})`);
    for (const line of f.slice(0, 15)) log(`         ${line}`);
    if (f.length > 15) log(`         … ${f.length - 15} more`);
    failed += f.length;
  }

  log();
  log("advisory:");
  const sentTotal = people.filter((p) => p.status === "sent").length;
  const refusedTotal = people.filter((p) => p.status === "refused").length;
  log(`  people: ${sentTotal} sent (${people.filter((p) => p.live && p.status === "sent").length} live), ${refusedTotal} refused; ${visits.length} visits on tagged docs; ${badTimeline} timeline issues`);
  const hist = new Map<string, number>();
  for (const o of outcomes) hist.set(o.bucket, (hist.get(o.bucket) ?? 0) + 1);
  log(`  people buckets (docs): ${["0", "1", "2-4", "5-15", "16-29", "30+", "?"].filter((b) => hist.has(b)).map((b) => `${b}: ${hist.get(b)}`).join(" · ")}`);

  let hotspot = 0;
  let withCallouts = 0;
  let leftHazard = 0;
  let withLeft = 0;
  const leftRoles = new Map<string, number>();
  const heldRoles = new Map<string, number>();
  for (const o of outcomes) {
    const A = o.api;
    const roles = manifest.docs.find((d) => d.docId === o.docId)!.pages;
    if (!A || !A.pages) continue;
    const top2 = (A.pages as Json[])
      .filter((p) => p.typicalMs !== null)
      .sort((a, b) => b.typicalMs - a.typicalMs)
      .slice(0, 2)
      .map((p) => roles[p.page - 1]);
    if (A.callouts) {
      withCallouts += 1;
      const held = A.callouts.heldLongest ? roles[A.callouts.heldLongest.page - 1] : null;
      if (held) heldRoles.set(held, (heldRoles.get(held) ?? 0) + 1);
      if ((held && HIGH_INTEREST.has(held)) || top2.some((r) => r && HIGH_INTEREST.has(r))) hotspot += 1;
      if (A.callouts.mostLeft) {
        withLeft += 1;
        const role = roles[A.callouts.mostLeft.page - 1] ?? "?";
        leftRoles.set(role, (leftRoles.get(role) ?? 0) + 1);
        if (HIGH_HAZARD.has(role)) leftHazard += 1;
      }
    }
  }
  const fmtMap = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  log(`  hotspot role (heldLongest or top-2 typical time is a high-interest role): ${hotspot} of ${withCallouts} docs with callouts; heldLongest roles: ${fmtMap(heldRoles)}`);
  log(`  mostLeft on a high-hazard role: ${leftHazard} of ${withLeft}; roles: ${fmtMap(leftRoles)}`);

  const now = Date.now();
  let notOpenedRows = 0;
  let notOpenedCandidates = 0;
  for (const o of outcomes) {
    if (o.api?.attention?.rows?.some((r: Json) => r.kind === "not_opened")) notOpenedRows += 1;
    const docLinks = links.filter((l) => String(l.docId) === o.docId && !l.archivedAt);
    const candidate = docLinks.some((l) => {
      const row = (o.api?.links as Json[] | undefined)?.find((x) => x.shareId === String(l.shareId));
      const exp = msOf(l.expiresAt);
      const active = l.enabled !== false && (exp === null || exp > now);
      const old = (msOf(l.createdDate) ?? now) <= now - 48 * 3_600_000;
      return active && old && row?.everOpened === false && (!l.isDefault || docLinks.length === 1);
    });
    if (candidate) notOpenedCandidates += 1;
  }
  log(`  docs with ≥1 not_opened attention row: ${notOpenedRows} (docs with an eligible never-opened link: ${notOpenedCandidates}; expect ≥15)`);

  const refusedWithPeople = traffic.refused.map((r) => {
    const o = outcomes.find((x) => x.docId === r.docId);
    const row = (o?.api?.links as Json[] | undefined)?.find((l) => l.shareId === r.shareId);
    return `${r.kind} ${r.shareId} status ${row?.status ?? "?"} people ${row?.people ?? "?"}`;
  });
  log(`  refused links: ${refusedWithPeople.join("; ") || "none"}`);
  const liveDocs = new Set(people.filter((p) => p.live && p.status === "sent").map((p) => p.docId));
  log(`  live docs: ${liveDocs.size}; docs with an active attention row now: ${activeRowsLive}`);
  log(
    `  hot rows by archetype: ${[...hotByArchetype.entries()].map(([a, t]) => `${a} ${t.hot}/${t.people} (${((t.hot / Math.max(1, t.people)) * 100).toFixed(0)}%)`).join(", ")}`,
  );
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]! : 0;
  log(`  /pages?matrix=all latency: p50 ${Math.round(sorted[sorted.length >> 1] ?? 0)}ms, p95 ${Math.round(p95)}ms, max ${Math.round(sorted.at(-1) ?? 0)}ms over ${sorted.length} calls`);
  const big = outcomes.filter((o) => o.people >= 30).map((o) => `${o.slug} (${o.people})`);
  log(`  docs with 30+ people: ${big.join(", ")}`);

  log();
  log(failed ? `FAILED: ${failed} gate check(s) failed.` : "All gates pass.");
  process.exitCode = failed ? 1 : 0;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
