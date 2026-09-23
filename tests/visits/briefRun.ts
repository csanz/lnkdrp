/**
 * End to end, the way it happens in life: an upload, a revision, a reader, a brief, an email.
 *
 *   1. `lnkdrp_share_pdf` over the MCP, with a fresh write key minted for the workspace owner.
 *   2. `lnkdrp_replace_pdf` with a second PDF, so the document has a revision and a compare.
 *   3. A fake reader opens the link and wanders through it: random pages, random dwell, going
 *      back to a page or two, holding on one for minutes, sometimes downloading. Driven through the
 *      public stats ingest with the exact payload shapes `PdfJsViewer` sends (`tv: 2`, `reason`,
 *      `toPage`, `numPages`), so the visit row carries reading order and revisit counts.
 *   4. Waits out the quiet window, calls `/api/cron/visit-briefs`, and prints the brief the model
 *      wrote and the email the cron sent.
 *
 * The email goes wherever the dev server's transport sends it. With `EMAIL_TRANSPORT=console` in
 * `.env.local` it lands in the dev server's log; start the server with `EMAIL_TRANSPORT=resend` to
 * get it in a real inbox. The script says which it expects, but it cannot change the server.
 *
 * Costs credits on the workspace it runs against: the upload summary (1), the revision's compare
 * (2 or 5 by tier) and the brief (1). Point it at a test workspace.
 *
 * Run:
 *   npx tsx --env-file=.env.local tests/visits/briefRun.ts
 *   npx tsx --env-file=.env.local tests/visits/briefRun.ts --reader "Priya Natarajan" --email priya@example.com
 *   npx tsx --env-file=.env.local tests/visits/briefRun.ts --pdf /abs/a.pdf --revision /abs/b.pdf --no-download
 *   npx tsx --env-file=.env.local tests/visits/briefRun.ts --docId <existing> --skip-upload   (reader + cron only)
 *   npx tsx --env-file=.env.local tests/visits/briefRun.ts --visits 2   (the same reader comes back; two briefs)
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { DocModel } from "@/lib/models/Doc";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { VisitBriefModel } from "@/lib/models/VisitBrief";
import { VISIT_QUIET_MS } from "@/lib/visits/scheduleVisitBrief";

const APP_URL = (process.env.TRAFFIC_APP_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const SEED_DIR = path.resolve(__dirname, "../share/.seed/pdf");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function log(s = ""): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

const between = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ToolResult = Record<string, unknown>;

async function callTool<T = ToolResult>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content.find((c) => c.type === "text") : undefined;
  const text = block && block.type === "text" ? block.text : null;
  if (result.isError) throw new Error(`${name} failed: ${text ?? "unknown error"}`);
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as T;
  if (!text) throw new Error(`${name}: no result`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------

type Step = { page: number; dwellMs: number };

/**
 * A wandering read. Forward mostly, one to three pages at a time; a quarter of the turns go back
 * to a page already seen. Two pages hold the reader for minutes, a few are flicked past in a
 * second or two, the rest get an honest ten to forty seconds. Never the same walk twice.
 */
export function randomWalk(numPages: number, opts: { steps?: number } = {}): Step[] {
  const steps = opts.steps ?? between(7, 12);
  const seen: number[] = [1];
  const walk: Step[] = [];
  let page = 1;
  const held = new Set<number>();
  while (held.size < Math.min(2, numPages)) held.add(between(2, Math.max(2, numPages)));

  for (let i = 0; i < steps; i++) {
    const kind = held.has(page) && !walk.some((s) => s.page === page && s.dwellMs > 60_000) ? "held" : Math.random() < 0.2 ? "flick" : "read";
    const dwellMs = kind === "held" ? between(60_000, 150_000) : kind === "flick" ? between(1_000, 3_000) : between(10_000, 40_000);
    walk.push({ page, dwellMs });

    // Next page: back to something seen, or forward.
    const back = seen.filter((p) => p !== page);
    if (back.length && Math.random() < 0.25) page = pick(back);
    else page = Math.min(numPages, page + between(1, 3));
    if (page === walk[walk.length - 1]!.page) page = Math.min(numPages, page + 1);
    if (!seen.includes(page)) seen.push(page);
    if (page === numPages && Math.random() < 0.5) {
      walk.push({ page, dwellMs: between(5_000, 20_000) });
      break;
    }
  }
  return walk;
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
 * Read the document as one sitting, exactly as the viewer reports it. Returns the total dwell.
 *
 * `endAt` is when the sitting finished on the virtual clock (default now), so two sittings by the
 * same reader can be laid end to end in the past without overlapping.
 */
async function readVisit(params: {
  shareId: string;
  botId: string;
  numPages: number;
  walk: Step[];
  intro: { viewerName?: string; viewerEmail?: string };
  paceMs: [number, number];
  realtime: boolean;
  endAt?: number;
}): Promise<number> {
  const { shareId, botId, numPages, walk, intro } = params;
  const visitId = `v_${randomUUID().replace(/-/g, "")}`;
  const total = walk.reduce((a, s) => a + s.dwellMs, 0);
  let cursor = (params.endAt ?? Date.now()) - total;
  const common = { botId, visitId, tv: 2, numPages };

  // Landing: the page they arrived on, and who they are (the viewer asks on the first screen).
  await postStats(shareId, { ...common, pageNumber: walk[0]!.page, ...intro, introduced: Boolean(intro.viewerName || intro.viewerEmail) });

  for (let i = 0; i < walk.length; i++) {
    const { page, dwellMs } = walk[i]!;
    const next = walk[i + 1]?.page ?? null;
    if (params.realtime) await sleep(dwellMs);
    else await sleep(between(params.paceMs[0], params.paceMs[1]));

    const enteredAtMs = cursor;
    const leftAtMs = cursor + dwellMs;
    cursor = leftAtMs;

    // Leaving this page: both clocks flushed, the reason and the destination as the viewer sends them.
    await postStats(shareId, {
      ...common,
      reason: next === null ? "pagehide" : "turn",
      durationMs: dwellMs,
      pageNumber: page,
      pageDurationMs: dwellMs,
      enteredAtMs,
      leftAtMs,
      ...(next === null ? {} : { toPage: next }),
    });
    if (next !== null) await postStats(shareId, { ...common, pageNumber: next });
  }
  return total;
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  await connectMongo();

  const readerName = arg("reader") ?? pick(["Priya Natarajan", "Tomás Herrera", "Mei-Lin Chao", "Anonymous"]);
  // Only an address you pass. An invented one makes the viewer's "confirm your email" a real send
  // to a stranger when the server is on the real transport.
  const readerEmail = arg("email");
  const intro = readerName === "Anonymous" ? {} : { viewerName: readerName, ...(readerEmail ? { viewerEmail: readerEmail } : {}) };
  const wantDownload = !flag("no-download") && Math.random() < 0.6;
  const realtime = flag("realtime");
  const transport = (process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase();

  // The workspace: the owner's personal org unless `--workspaceId` says otherwise.
  const ownerEmail = arg("owner") ?? "chrissanz@gmail.com";
  const owner = (await UserModel.findOne({ email: ownerEmail.toLowerCase() }).select({ _id: 1 }).lean()) as { _id: Types.ObjectId } | null;
  if (!owner) throw new Error(`no user ${ownerEmail}`);
  const orgIdArg = arg("workspaceId");
  const org = orgIdArg
    ? await OrgModel.findById(orgIdArg).select({ _id: 1, name: 1 }).lean()
    : await OrgModel.findOne({ personalForUserId: owner._id }).select({ _id: 1, name: 1 }).lean();
  if (!org) throw new Error("no workspace");
  const orgId = String((org as { _id: unknown })._id);
  const member = await OrgMembershipModel.findOne({ orgId: new Types.ObjectId(orgId), userId: owner._id, isDeleted: { $ne: true } })
    .select({ briefEmailMode: 1 })
    .lean();
  const briefMode = (member as { briefEmailMode?: string } | null)?.briefEmailMode ?? "immediate";

  log(`workspace: ${(org as { name?: string }).name ?? orgId} (${orgId}) · owner ${ownerEmail} · brief emails: ${briefMode}`);
  log(
    transport === "console"
      ? `email: .env.local says EMAIL_TRANSPORT=console — the email lands in the dev server's log unless the server was started with EMAIL_TRANSPORT=resend`
      : `email: transport "${transport || "resend"}" — the email goes to ${ownerEmail}`,
  );
  if (briefMode === "off") log("NOTE: this member has brief emails off; the brief is written but nothing is sent");
  log();

  const seeds = readdirSync(SEED_DIR).filter((f) => f.endsWith(".pdf")).map((f) => path.join(SEED_DIR, f));
  const pdf = arg("pdf") ?? pick(seeds);
  const revision = arg("revision") ?? pick(seeds.filter((f) => f !== pdf));

  const created = await createApiKey({ orgId, userId: String(owner._id), name: `brief run ${new Date().toISOString()}` });
  const mcp = new Client({ name: "lnkdrp-brief-run", version: "1.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } } }));

  let docId = arg("docId");
  let shareId: string | null = null;
  try {
    if (docId && flag("skip-upload")) {
      const doc = (await DocModel.findById(docId).select({ shareId: 1, title: 1 }).lean()) as { shareId?: string; title?: string } | null;
      if (!doc?.shareId) throw new Error("document not found");
      shareId = doc.shareId;
      log(`document: ${doc.title} (${docId}) — existing, upload skipped`);
    } else {
      // 1. Upload.
      const title = `${path.basename(pdf, ".pdf").replace(/-/g, " ")} (brief run ${new Date().toISOString().slice(11, 16)})`;
      log(`1. lnkdrp_share_pdf: ${path.basename(pdf)} as "${title}"`);
      const shared = await callTool<{ docId: string; shareId: string; shareUrl: string; status: string; warnings?: unknown }>(mcp, "lnkdrp_share_pdf", {
        filePath: pdf,
        title,
        allowDownload: true,
        idempotencyKey: `brief-run-${randomUUID()}`,
        timeoutSeconds: 120,
      });
      docId = shared.docId;
      shareId = shared.shareId;
      log(`   ${shared.shareUrl} · status ${shared.status}${Array.isArray(shared.warnings) && shared.warnings.length ? ` · warnings: ${JSON.stringify(shared.warnings)}` : ""}`);

      // 2. Revision.
      log(`2. lnkdrp_replace_pdf: ${path.basename(revision)}`);
      const replaced = await callTool<{ version: number; status: string; unchangedFromPrevious?: boolean; warnings?: unknown }>(mcp, "lnkdrp_replace_pdf", {
        docId,
        filePath: revision,
        idempotencyKey: `brief-run-rev-${randomUUID()}`,
        timeoutSeconds: 120,
      });
      log(`   version ${replaced.version} · status ${replaced.status}${replaced.unchangedFromPrevious ? " · unchanged from previous" : ""}`);
    }

    // 3. The reader — one sitting, or several by the same person laid end to end in the past, so
    //    the later ones are returns with a previous visit to compare against.
    const doc = (await DocModel.findById(docId).select({ slideNodes: 1, title: 1 }).lean()) as { slideNodes?: unknown[]; title?: string } | null;
    const numPages = Math.max(1, Array.isArray(doc?.slideNodes) ? doc!.slideNodes!.length : 1);
    const botId = `b_${randomUUID().replace(/-/g, "")}`;
    const sittings = Math.max(1, Math.min(4, Number(arg("visits") ?? 1) || 1));
    const walks = Array.from({ length: sittings }, () => randomWalk(numPages));
    // Lay them out backwards from now: the last sitting ends now, each earlier one ends a random
    // hour or two before the next one starts.
    const endAts: number[] = [];
    let end = Date.now();
    for (let i = sittings - 1; i >= 0; i--) {
      endAts[i] = end;
      const total = walks[i]!.reduce((a, s) => a + s.dwellMs, 0);
      end = end - total - between(1, 3) * 60 * 60 * 1000;
    }
    for (let i = 0; i < sittings; i++) {
      const walk = walks[i]!;
      const held = walk.filter((s) => s.dwellMs >= 60_000).map((s) => `p${s.page}`);
      const revisited = walk.map((s) => s.page).filter((p, i2, a) => a.indexOf(p) !== i2);
      log(`3.${sittings > 1 ? i + 1 : ""} reader: ${readerName}${readerEmail ? ` <${readerEmail}>` : ""} · ${numPages} pages · walk ${walk.map((s) => `${s.page}(${Math.round(s.dwellMs / 1000)}s)`).join(" → ")}`);
      log(`   held: ${held.join(", ") || "none"} · went back to: ${Array.from(new Set(revisited)).map((p) => `p${p}`).join(", ") || "nothing"}${wantDownload && i === sittings - 1 ? " · downloads" : ""}`);
      const total = await readVisit({ shareId: shareId!, botId, numPages, walk, intro, paceMs: [800, 2_000], realtime, endAt: endAts[i] });
      log(`   reported ${Math.round(total / 1000)}s of reading`);
    }
    if (wantDownload) {
      const res = await fetch(`${APP_URL}/s/${encodeURIComponent(shareId!)}/pdf?download=1&botId=${encodeURIComponent(botId)}`);
      log(`   download: ${res.status}`);
    }

    // 4. The quiet window, then the cron.
    const wait = VISIT_QUIET_MS + 10_000;
    log(`4. waiting ${Math.round(wait / 1000)}s for the visit to go quiet…`);
    await sleep(wait);
    const cronRes = await fetch(`${APP_URL}/api/cron/visit-briefs?workspaceId=${orgId}`, { method: "POST" });
    const cron = (await cronRes.json()) as Record<string, unknown>;
    log(`   cron: ${cronRes.status} · claimed ${cron.claimed} · briefed ${cron.briefed} · recap ${cron.recap} · skipped ${cron.skipped} · credits ${cron.creditsCharged} · emails sent ${(cron.emails as { queue?: { sent?: number } } | null)?.queue?.sent ?? 0}`);

    const botIdHash = createHash("sha256").update(botId).digest("hex");
    const rows = (await VisitBriefModel.find({ shareId, botIdHash }).sort({ startedAt: 1 }).lean()) as Array<Record<string, any>>;
    log();
    if (!rows.length) log("no VisitBrief row for this reader");
    for (const row of rows) {
      log(`VisitBrief ${row._id} · ${row.status}${row.recapReason ? ` (${row.recapReason})` : ""} · ${Math.round((row.stats?.timeSpentMs ?? 0) / 1000)}s · ${row.stats?.pagesSeen} of ${row.stats?.pageCount ?? "?"} pages · visit #${row.stats?.visitNumber}`);
      if (row.brief) {
        log(`Subject: ${row.brief.headline}`);
        log(`         ${row.brief.body}`);
        for (const h of row.brief.interests ?? []) log(`         ★ ${h}`);
        for (const h of row.brief.highlights ?? []) log(`         - ${h}`);
        if (row.brief.followUp) log(`         Next: ${row.brief.followUp}`);
        log(`         (${row.brief.model}, ${row.brief.tokensIn} in / ${row.brief.tokensOut} out, ${row.brief.latencyMs} ms)`);
      }
      log(`Reader page: ${APP_URL}/doc/${docId}/metrics/viewer/a_${botIdHash}`);
    }
  } finally {
    await mcp.close().catch(() => undefined);
    await revokeApiKey({ orgId, keyId: created.key.id }).catch(() => undefined);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
