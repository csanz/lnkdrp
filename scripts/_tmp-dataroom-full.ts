/**
 * Full data-room drive (temporary), round 2: every event the feed records, checked against what
 * reached Slack, per channel. Phase "build": four new documents over the MCP (posted to the
 * catch-all: not in a room yet), added to the Data room (posted to the room's channel), a
 * document link and a data-room link, one replacement, one investor who introduces herself on
 * the landing page and reads two documents. Phase "brief": wait, tick, and print the ledger.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { DocModel } from "@/lib/models/Doc";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { SlackOutboxModel } from "@/lib/models/SlackOutbox";
import { VisitBriefModel } from "@/lib/models/VisitBrief";
import { renderSlackEvent } from "@/lib/slack/messages";
import { exit } from "./lib/exit";

const ORG_ID = "6ab46f3add6983534677931d";
const USER_ID = "6ab46f3a542dc85d9d3ba00f";
const PROJECT_ID = "6ab694307102af9d9d25d6a6";
const APP = "http://localhost:3001";
const PHASE = process.argv[2] ?? "build";
const STATE = `${process.env.SCRATCH ?? "."}/dataroom-full.json`;
const PDF = {
  a: "https://pdfobject.com/pdf/sample-3pp.pdf",
  b: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf",
  c: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-links/links.pdf",
  d: "https://pdfobject.com/pdf/sample.pdf",
  e: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-bookmarks/bookmarks.pdf",
};
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36";
const log = (s: string, extra?: unknown) => console.log(`\n== ${s}`, extra === undefined ? "" : JSON.stringify(extra));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const sc = (res as { structuredContent?: unknown }).structuredContent;
  if (sc) return sc as T;
  const text = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []).find((c) => c.type === "text")?.text ?? "{}";
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

async function ledger(since: Date) {
  const orgId = new Types.ObjectId(ORG_ID);
  const conns = await SlackConnectionModel.find({ orgId }).select({ channelName: 1 }).lean();
  const name = new Map(conns.map((c) => [String(c._id), c.channelName]));
  const posts = await SlackOutboxModel.find({ orgId, createdDate: { $gte: since } }).sort({ createdDate: 1 }).lean();
  const acts = await ActivityEventModel.find({ orgId, createdDate: { $gte: since } }).select({ type: 1 }).lean();
  const byType: Record<string, number> = {};
  for (const a of acts) byType[a.type] = (byType[a.type] ?? 0) + 1;
  const slack: string[] = [];
  for (const p of posts) {
    const text = (await renderSlackEvent(p as never).catch(() => null))?.text ?? "(renders nothing)";
    slack.push(`${p.kind}${p.event?.change ? "/" + p.event.change : ""}${p.event?.introduced ? "/intro" : ""} -> ${name.get(String(p.connectionId))} [${p.status}${p.skippedReason ? " " + p.skippedReason : ""}${p.lastError ? " " + p.lastError : ""}]  "${text}"`);
  }
  return { activity: byType, slack };
}

(async () => {
  await connectMongo();
  if (PHASE === "build") {
    const since = new Date();
    const created = await createApiKey({ orgId: ORG_ID, userId: USER_ID, name: `full drive ${since.toISOString()}`, scopes: ["read", "write"] });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } } });
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    const docs: Record<string, string> = {};
    let docLinkShareId = "";
    let roomLinkShareId = "";
    try {
      await client.connect(transport);
      const titles: Array<[string, string, string]> = [
        ["terms", "Series A term sheet draft", PDF.a],
        ["board", "Board deck Q3 2026", PDF.b],
        ["customers", "Top 20 customers", PDF.c],
        ["ip", "IP assignment agreements", PDF.d],
      ];
      for (const [key, title, url] of titles) {
        const existing = (await DocModel.findOne({ orgId: new Types.ObjectId(ORG_ID), title, isDeleted: { $ne: true } }).select({ _id: 1 }).lean()) as { _id: Types.ObjectId } | null;
        if (existing) {
          docs[key] = String(existing._id);
          log(`reuse ${title}`, { docId: docs[key] });
          continue;
        }
        const r = await call<{ docId: string; status: string }>(client, "lnkdrp_share_pdf", { idempotencyKey: `full-${randomUUID()}`, title, sourceUrl: url, waitForReady: true, timeoutSeconds: 120 });
        docs[key] = r.docId;
        log(`share_pdf ${title}`, { docId: r.docId, status: r.status });
      }
      await sleep(3000);
      log("after creates", await ledger(since));

      const added = await call<{ added: string[]; alreadyInProject?: string[] }>(client, "lnkdrp_add_docs_to_project", { projectId: PROJECT_ID, docIds: Object.values(docs) });
      log("add_docs_to_project", { added: added.added.length, already: added.alreadyInProject?.length ?? 0 });
      await sleep(3000);

      const dl = await call<{ link: { id: string; shareId: string; label: string } }>(client, "lnkdrp_create_share_link", { docId: docs.terms, label: "Lead investor", audience: "Benchmark · Sarah", allowDownload: false });
      docLinkShareId = dl.link.shareId;
      log("create_share_link", dl.link);
      const pl = await call<{ link: { id: string; shareId: string; label: string } }>(client, "lnkdrp_create_project_link", { projectId: PROJECT_ID, label: "Index Ventures", audience: "Index · Growth", allowDownload: true });
      roomLinkShareId = pl.link.shareId;
      log("create_project_link", pl.link);
      await sleep(3000);

      const rep = await call<{ version: number; status: string; warnings?: string[] }>(client, "lnkdrp_replace_pdf", { idempotencyKey: `full-rep-${randomUUID()}`, docId: docs.board, sourceUrl: PDF.e, waitForReady: true, timeoutSeconds: 120 });
      log("replace_pdf board", { version: rep.version, status: rep.status, warnings: rep.warnings ?? [] });
    } finally {
      await client.close().catch(() => {});
      await revokeApiKey({ orgId: ORG_ID, keyId: created.key.id }).catch(() => {});
    }

    // The investor: landing-page introduction, then two documents with nameless timing posts.
    const botId = `full-sarah-${randomUUID()}`;
    const landing = await fetch(`${APP}/api/share/${roomLinkShareId}/landing`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify({ botId, viewerName: "Sarah Kim", viewerEmail: "sarah@benchmark.example" }) });
    log("landing introduce", { status: landing.status });
    for (const [key, pages, secs] of [["terms", 3, 30], ["customers", 2, 45]] as Array<[string, number, number]>) {
      const visitId = randomUUID();
      const t0 = Date.now();
      let total = 0;
      for (let p = 1; p <= pages; p += 1) {
        const body: Record<string, unknown> = { botId, visitId, docId: docs[key], pageNumber: p, enteredAtMs: t0, numPages: pages };
        if (p > 1) Object.assign(body, { durationMs: total, pageDurationMs: secs * 1000 });
        const r = await fetch(`${APP}/api/share/${roomLinkShareId}/stats`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) });
        if (r.status !== 200) log(`stats ${key} p${p}`, { status: r.status });
        total += secs * 1000;
        await sleep(300);
      }
    }
    await sleep(5000);
    fs.writeFileSync(STATE, JSON.stringify({ since: since.toISOString(), docs, docLinkShareId, roomLinkShareId }, null, 2));
    log("after build", await ledger(since));
  } else {
    const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { since: string; docs: Record<string, string> };
    const since = new Date(st.since);
    const wait = Number(process.argv[3] ?? 150);
    console.log(`waiting ${wait}s`);
    await sleep(wait * 1000);
    const cron = await fetch(`${APP}/api/cron/visit-briefs?workspaceId=${ORG_ID}`, { method: "POST" });
    const body = (await cron.json().catch(() => null)) as Record<string, unknown> | null;
    log("tick", { status: cron.status, claimed: body?.claimed, briefed: body?.briefed, recap: body?.recap, postponed: body?.postponed, creditsCharged: body?.creditsCharged });
    await sleep(6000);
    const rows = await VisitBriefModel.find({ orgId: new Types.ObjectId(ORG_ID), createdDate: { $gte: since } }).select({ viewerName: 1, status: 1, recapReason: 1, "brief.headline": 1 }).lean();
    log("brief rows", rows.map((b) => ({ who: b.viewerName, status: b.status, reason: b.recapReason ?? null, headline: (b as { brief?: { headline?: string } }).brief?.headline ?? null })));
    log("final", await ledger(since));
  }
  await exit(0);
})().catch(async (e) => { console.error("FAILED", e instanceof Error ? e.message : e); await exit(1); });
