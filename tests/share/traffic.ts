/**
 * Simulate recipients reading a shared document, so the analytics screens have real shapes on them.
 *
 * This drives the **public** ingest the browser drives — `POST /api/share/:shareId/stats` and
 * `GET /s/:shareId/pdf?download=1` — with the exact payload shapes `PdfJsViewer` sends. That is
 * the point: a generator that invents its own payloads tests nothing, because the shape *is* the
 * contract. Each reader therefore produces the same sequence a browser would:
 *
 *   load          { botId, visitId, pageNumber }                       — the page they landed on
 *   page turn     { botId, visitId, durationMs, pageNumber,            — the page they just left,
 *                   pageDurationMs, enteredAtMs, leftAtMs }              with both clocks flushed
 *   (nav)         { botId, visitId, pageNumber }                       — the page they moved to
 *   close         { botId, visitId, durationMs, pageNumber,            — the page they were on
 *                   pageDurationMs, enteredAtMs, leftAtMs }              when they left
 *
 * Readers differ on purpose. One skims two pages, one reads properly and lingers, one bounces off
 * page 1, one comes back a second time in a new tab, and some introduce themselves so the viewer
 * list has names in it. A generator where every reader behaves identically produces a chart with
 * no shape and viewer rows that are all the same row.
 *
 * **Reported dwell is simulated; wall-clock gaps are the pacing.** A reader who spends 90 seconds
 * on a page reports 90 seconds, but the script waits only the pacing gap and backdates
 * `enteredAtMs`/`leftAtMs` so the interval is self-consistent. Waiting the real 90 seconds would
 * make a five-reader run take half an hour. Use `--realtime` when you want the wall clock to match.
 *
 * Read-only on the owner's side: it creates no documents and no links, only the analytics rows a
 * real reader would create. Those are real view counts on a real link — point it at a test
 * workspace, never at a customer's document.
 *
 * Run:
 *   npx tsx --env-file=.env.local tests/share/traffic.ts --doc "Live Audit Deck"
 *   npx tsx --env-file=.env.local tests/share/traffic.ts --docId <id> --readers 8 --pace 2-6
 *
 * Then read it back the way an agent would:
 *   npx tsx --env-file=.env.local tests/mcp/analytics.ts --doc "Live Audit Deck"
 */
import { randomUUID } from "node:crypto";

import { Types } from "mongoose";

import { describePacing, pause, pauseBetweenActors, resolvePacing, type Pacing } from "../pace";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareLinkModel } from "@/lib/models/ShareLink";

const APP_URL = (process.env.TRAFFIC_APP_URL ?? "http://localhost:3001").replace(/\/+$/, "");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

function log(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

function between(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/** One reader's behaviour on one link. */
type Reader = {
  label: string;
  /** Anonymous readers may introduce themselves on the share page; most never do. */
  name: string | null;
  email: string | null;
  /** Pages in the order they are read, and how long each is looked at (reported, not waited). */
  pages: number[];
  dwellMs: number[];
  downloads: boolean;
  /** A second visit later, in a new tab: same browser, new `visitId`. */
  returnsWith?: { pages: number[]; dwellMs: number[] };
};

const FIRST = ["Dana", "Priya", "Marcus", "Ines", "Tomas", "Amara", "Noor", "Felix"] as const;
const LAST = ["Whitfield", "Okafor", "Lindqvist", "Haddad", "Moreau", "Castellanos"] as const;
const DOMAIN = ["sequoia.test", "benchmark.test", "indexvc.test", "gmail.test"] as const;

/**
 * Build a cast of readers whose behaviour differs in the ways the metrics screens are meant to
 * show: depth of read, time on page, a bounce, a return visit, a download, named versus anonymous.
 */
function buildReaders(count: number, maxPage: number): Reader[] {
  const readers: Reader[] = [];
  const deep = Math.max(1, maxPage);
  for (let i = 0; i < count; i++) {
    const named = i % 3 === 0;
    const first = pick(FIRST);
    const name = named ? `${first} ${pick(LAST)}` : null;
    const email = named ? `${first.toLowerCase()}@${pick(DOMAIN)}` : null;
    const kind = i % 4;

    if (kind === 0) {
      // Bounced: opened page 1, left almost at once. The row that stops "views" meaning "read".
      readers.push({ label: "bounced", name, email, pages: [1], dwellMs: [between(2_000, 6_000)], downloads: false });
    } else if (kind === 1) {
      // Skimmed the first few pages, briefly.
      const pages = Array.from({ length: Math.min(3, deep) }, (_, n) => n + 1);
      readers.push({
        label: "skimmed",
        name,
        email,
        pages,
        dwellMs: pages.map(() => between(4_000, 15_000)),
        downloads: false,
      });
    } else if (kind === 2) {
      // Read it properly and lingered on one page — the shape worth spotting on the page-time chart.
      const pages = Array.from({ length: Math.min(5, deep) }, (_, n) => n + 1);
      const dwellMs = pages.map(() => between(12_000, 40_000));
      dwellMs[Math.min(2, dwellMs.length - 1)] = between(70_000, 140_000);
      readers.push({ label: "read closely", name, email, pages, dwellMs, downloads: true });
    } else {
      // Came back later in a new tab: same browser, second visit, further into the deck.
      const pages = Array.from({ length: Math.min(2, deep) }, (_, n) => n + 1);
      const back = Array.from({ length: Math.min(4, deep) }, (_, n) => n + 1).slice(1);
      readers.push({
        label: "returned",
        name,
        email,
        pages,
        dwellMs: pages.map(() => between(6_000, 20_000)),
        downloads: false,
        returnsWith: back.length ? { pages: back, dwellMs: back.map(() => between(10_000, 45_000)) } : undefined,
      });
    }
  }
  return readers;
}

async function postStats(shareId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${APP_URL}/api/share/${encodeURIComponent(shareId)}/stats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stats POST ${res.status} for ${shareId}`);
}

/**
 * One sitting: land on a page, turn through the rest, leave. Returns the total reported dwell.
 *
 * `endAtMs` is when the sitting finished, so the reported intervals end "now" and the visit's
 * `startedAt` lands the right distance in the past.
 */
async function readVisit(
  shareId: string,
  botId: string,
  reader: Reader,
  plan: { pages: number[]; dwellMs: number[] },
  pacing: Pacing,
  realtime: boolean,
): Promise<number> {
  const visitId = `v_${randomUUID().replace(/-/g, "")}`;
  const total = plan.dwellMs.reduce((a, b) => a + b, 0);
  // The virtual clock: the sitting ends now, so it began `total` ago.
  let cursor = Date.now() - total;

  const intro = reader.name || reader.email ? { viewerName: reader.name, viewerEmail: reader.email } : {};
  await postStats(shareId, { botId, visitId, pageNumber: plan.pages[0], ...intro });

  for (let i = 0; i < plan.pages.length; i++) {
    const page = plan.pages[i]!;
    const dwell = plan.dwellMs[i]!;
    if (realtime) await new Promise((r) => setTimeout(r, dwell));
    else await pause(pacing);

    const enteredAtMs = cursor;
    const leftAtMs = cursor + dwell;
    cursor = leftAtMs;

    // Leaving this page: both clocks flushed, exactly as the viewer's page-change effect does.
    await postStats(shareId, {
      botId,
      visitId,
      durationMs: dwell,
      pageNumber: page,
      pageDurationMs: dwell,
      enteredAtMs,
      leftAtMs,
      ...intro,
    });

    // Arriving at the next page: the nav POST that records it as seen.
    const next = plan.pages[i + 1];
    if (next !== undefined) await postStats(shareId, { botId, visitId, pageNumber: next, ...intro });
  }
  return total;
}

async function main(): Promise<void> {
  const pacing = resolvePacing();
  const realtime = process.argv.includes("--realtime");
  const readerCount = Math.max(1, Math.min(40, Number(arg("readers") ?? 6)));
  await connectMongo();

  const docIdArg = arg("docId");
  const titleArg = arg("doc");
  const doc = docIdArg
    ? await DocModel.findById(new Types.ObjectId(docIdArg)).select({ _id: 1, title: 1, numberOfPages: 1 }).lean()
    : await DocModel.findOne({ title: titleArg ?? /./, isDeleted: { $ne: true } })
        .sort({ createdDate: -1 })
        .select({ _id: 1, title: 1, numberOfPages: 1 })
        .lean();
  if (!doc) throw new Error("no document matched; pass --docId or --doc <title>");
  const d = doc as unknown as { _id: Types.ObjectId; title?: string; numberOfPages?: number };

  const links = await ShareLinkModel.find({ docId: d._id, archivedAt: null, enabled: true })
    .select({ shareId: 1, label: 1, allowDownload: 1, passwordHash: 1 })
    .lean<Array<{ shareId: string; label: string; allowDownload?: boolean; passwordHash?: string | null }>>();
  const open = links.filter((l) => !l.passwordHash);
  if (!open.length) throw new Error("no open (alive, unpassworded) links on this document");

  const maxPage = Math.max(2, Math.min(12, d.numberOfPages ?? 5));
  const readers = buildReaders(readerCount, maxPage);

  log(`document: ${d.title} (${String(d._id)}) · ${maxPage} pages`);
  log(`links: ${open.map((l) => `${l.label} (${l.shareId})`).join(", ")}`);
  log(`${readers.length} readers · ${describePacing(pacing)}${realtime ? " · REAL-TIME dwell" : " · dwell is reported, not waited"}`);
  log();

  let visits = 0;
  let downloads = 0;
  for (let i = 0; i < readers.length; i++) {
    const reader = readers[i]!;
    // Round-robin so every link gets traffic and the per-link table has something to compare.
    const link = open[i % open.length]!;
    const botId = `b_${randomUUID().replace(/-/g, "")}`;

    if (i) await pauseBetweenActors(pacing);
    const firstMs = await readVisit(link.shareId, botId, reader, { pages: reader.pages, dwellMs: reader.dwellMs }, pacing, realtime);
    visits += 1;
    let detail = `${reader.label}, pages ${reader.pages.join("→")}, ${Math.round(firstMs / 1000)}s`;

    if (reader.downloads && link.allowDownload) {
      await pause(pacing);
      const res = await fetch(`${APP_URL}/s/${encodeURIComponent(link.shareId)}/pdf?download=1&botId=${encodeURIComponent(botId)}`);
      if (res.ok) {
        downloads += 1;
        detail += ", downloaded";
      }
      // Drain the body so the connection is not left open.
      await res.arrayBuffer().catch(() => undefined);
    }

    if (reader.returnsWith) {
      await pauseBetweenActors(pacing);
      const backMs = await readVisit(link.shareId, botId, reader, reader.returnsWith, pacing, realtime);
      visits += 1;
      detail += `; returned for pages ${reader.returnsWith.pages.join("→")}, ${Math.round(backMs / 1000)}s`;
    }

    log(`${(reader.name ?? "anonymous").padEnd(22)} on "${link.label}": ${detail}`);
  }

  log();
  log(`${readers.length} readers, ${visits} visits, ${downloads} downloads.`);
  log(`Analytics are written by the ingest in the background; give it a second, then:`);
  log(`  npx tsx --env-file=.env.local tests/mcp/analytics.ts --docId ${String(d._id)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
