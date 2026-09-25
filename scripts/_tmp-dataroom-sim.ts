/**
 * Data-room simulation over the MCP (temporary). Phase "build": four documents into the Data room
 * project, a named project link, two revisions, two investors reading through the link with an
 * introduction. Phase "brief": wait for the visits to go quiet, run the brief tick, report what
 * reached Slack (per channel), the feed, and the briefs.
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
import { exit } from "./lib/exit";

const ORG_ID = "6ab46f3add6983534677931d";
const USER_ID = "6ab46f3a542dc85d9d3ba00f";
const PROJECT_ID = "6ab694307102af9d9d25d6a6";
const APP = "http://localhost:3001";
const PHASE = process.argv[2] ?? "build";
const STATE = `${process.env.SCRATCH ?? "."}/dataroom-sim.json`;

const PDF = {
  deck: "https://pdfobject.com/pdf/sample-3pp.pdf",
  model: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf",
  captable: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-links/links.pdf",
  contracts: "https://pdfobject.com/pdf/sample.pdf",
  dummy: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
};

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

async function report(since: Date) {
  const orgId = new Types.ObjectId(ORG_ID);
  const conns = await SlackConnectionModel.find({ orgId }).select({ channelName: 1 }).lean();
  const name = new Map(conns.map((c) => [String(c._id), c.channelName]));
  const posts = await SlackOutboxModel.find({ orgId, createdDate: { $gte: since } }).sort({ createdDate: 1 }).lean();
  const acts = await ActivityEventModel.find({ orgId, createdDate: { $gte: since } }).select({ type: 1 }).lean();
  const byType: Record<string, number> = {};
  for (const a of acts) byType[a.type] = (byType[a.type] ?? 0) + 1;
  return {
    slack: posts.map((p) => `${p.kind} -> ${name.get(String(p.connectionId))} [${p.status}${p.lastError ? ` ${p.lastError}` : ""}]`),
    activity: byType,
  };
}

const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Chrome/128 Safari/537.36";
async function read(shareId: string, docId: string, botId: string, visitId: string, pages: number, secondsPerPage: number, intro?: { name: string; email: string }) {
  const t0 = Date.now();
  let total = 0;
  for (let p = 1; p <= pages; p += 1) {
    const body: Record<string, unknown> = { botId, visitId, docId, pageNumber: p, enteredAtMs: t0 };
    if (p === 1 && intro) Object.assign(body, { viewerName: intro.name, viewerEmail: intro.email, introduced: true });
    if (p > 1) Object.assign(body, { durationMs: total, pageDurationMs: secondsPerPage * 1000, leftAtMs: t0 + total });
    const r = await fetch(`${APP}/api/share/${shareId}/stats`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) });
    if (r.status !== 200) log(`stats ${shareId} p${p}`, { status: r.status, body: (await r.text()).slice(0, 160) });
    total += secondsPerPage * 1000;
    await sleep(400);
  }
}

(async () => {
  await connectMongo();
  if (PHASE === "build") {
    const since = new Date();
    const created = await createApiKey({ orgId: ORG_ID, userId: USER_ID, name: `dataroom sim ${since.toISOString()}`, scopes: ["read", "write"] });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } } });
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    const docs: Record<string, string> = {};
    let linkShareId = "";
    try {
      await client.connect(transport);
      const titles: Array<[string, string, string]> = [
        ["deck", "Acme Series A pitch deck", PDF.deck],
        ["model", "Acme financial model FY26", PDF.model],
        ["captable", "Acme cap table", PDF.captable],
        ["contracts", "Customer contracts summary", PDF.contracts],
      ];
      for (const [key, title, url] of titles) {
        // Resumable: a document of this title that an earlier run already created is reused.
        const existing = (await DocModel.findOne({ orgId: new Types.ObjectId(ORG_ID), title, isDeleted: { $ne: true } }).select({ _id: 1 }).lean()) as { _id: Types.ObjectId } | null;
        if (existing) {
          docs[key] = String(existing._id);
          log(`reuse ${title}`, { docId: docs[key] });
          continue;
        }
        const r = await call<{ docId: string; status: string; version: number }>(client, "lnkdrp_share_pdf", { idempotencyKey: `dr-${randomUUID()}`, title, sourceUrl: url, waitForReady: true, timeoutSeconds: 120 });
        docs[key] = r.docId;
        log(`share_pdf ${title}`, { docId: r.docId, status: r.status });
      }
      const added = await call<{ added: string[] }>(client, "lnkdrp_add_docs_to_project", { projectId: PROJECT_ID, docIds: Object.values(docs) });
      log("add_docs_to_project", { added: added.added.length });
      const link = await call<{ link: { shareId: string; label: string; url?: string } }>(client, "lnkdrp_create_project_link", { projectId: PROJECT_ID, label: "Sequoia Capital", audience: "Sequoia · Growth", allowDownload: true });
      linkShareId = link.link.shareId;
      log("create_project_link", link.link);

      // Revisions: the deck and the model each get a second version.
      for (const [key, url] of [["deck", PDF.dummy], ["model", PDF.contracts]] as Array<[string, string]>) {
        const r = await call<{ version: number; status: string; warnings?: string[] }>(client, "lnkdrp_replace_pdf", { idempotencyKey: `dr-rep-${randomUUID()}`, docId: docs[key], sourceUrl: url, waitForReady: true, timeoutSeconds: 120 });
        log(`replace_pdf ${key}`, { version: r.version, status: r.status, warnings: r.warnings ?? [] });
      }
    } finally {
      await client.close().catch(() => {});
      await revokeApiKey({ orgId: ORG_ID, keyId: created.key.id }).catch(() => {});
    }

    // Two investors read through the Sequoia link and introduce themselves.
    const priya = { botId: `dr-priya-${randomUUID()}`, name: "Priya Nair", email: "priya@sequoiacap.example" };
    const tom = { botId: `dr-tom-${randomUUID()}`, name: "Tom Becker", email: "tom@indexventures.example" };
    await read(linkShareId, docs.deck, priya.botId, randomUUID(), 3, 30, { name: priya.name, email: priya.email });
    await read(linkShareId, docs.model, priya.botId, randomUUID(), 2, 45);
    await read(linkShareId, docs.captable, tom.botId, randomUUID(), 1, 40, { name: tom.name, email: tom.email });
    await read(linkShareId, docs.deck, tom.botId, randomUUID(), 2, 25);
    await sleep(5000);
    fs.writeFileSync(STATE, JSON.stringify({ since: since.toISOString(), docs, linkShareId }, null, 2));
    log("after build", await report(since));
    log("saved", { docs, linkShareId });
  } else {
    const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { since: string; docs: Record<string, string> };
    const since = new Date(st.since);
    const wait = Number(process.argv[3] ?? 150);
    console.log(`waiting ${wait}s for the visits to go quiet`);
    await sleep(wait * 1000);
    await VisitBriefModel.updateMany({ orgId: new Types.ObjectId(ORG_ID), status: "scheduled", docId: { $in: Object.values(st.docs).map((d) => new Types.ObjectId(d)) } }, { $set: { dueAt: new Date(Date.now() - 1000) } });
    const cron = await fetch(`${APP}/api/cron/visit-briefs?workspaceId=${ORG_ID}`, { method: "POST" });
    const body = (await cron.json().catch(() => null)) as Record<string, unknown> | null;
    log("visit-briefs tick", { status: cron.status, claimed: body?.claimed, briefed: body?.briefed, recap: body?.recap, postponed: body?.postponed, failed: body?.failed });
    await sleep(6000);
    const briefs = await VisitBriefModel.find({ orgId: new Types.ObjectId(ORG_ID), docId: { $in: Object.values(st.docs).map((d) => new Types.ObjectId(d)) } }).select({ status: 1, viewerName: 1, recapReason: 1, "brief.headline": 1 }).lean();
    log("briefs", briefs.map((b) => ({ who: b.viewerName, status: b.status, reason: b.recapReason ?? null, headline: (b as { brief?: { headline?: string } }).brief?.headline ?? null })));
    log("final", await report(since));
  }
  await exit(0);
})().catch(async (e) => { console.error("FAILED", e instanceof Error ? e.message : e); await exit(1); });
