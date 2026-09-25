/**
 * The real data-room flow (temporary): a new investor introduces herself on the landing page
 * (which is where the /p/ page sends it), then reads two documents whose timing posts carry no
 * name. Phase "read" does that; phase "brief" waits, ticks, and shows whether the briefs, the feed
 * and Slack name her.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";

import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { SlackOutboxModel } from "@/lib/models/SlackOutbox";
import { VisitBriefModel } from "@/lib/models/VisitBrief";
import { exit } from "./lib/exit";

const ORG_ID = "6ab46f3add6983534677931d";
const PROJECT_ID = "6ab694307102af9d9d25d6a6";
const APP = "http://localhost:3001";
const PHASE = process.argv[2] ?? "read";
const STATE = `${process.env.SCRATCH ?? "."}/dataroom-sim.json`;
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string, extra?: unknown) => console.log(`\n== ${s}`, extra === undefined ? "" : JSON.stringify(extra));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const st = JSON.parse(fs.readFileSync(STATE, "utf8")) as { docs: Record<string, string>; linkShareId: string; elena?: { botId: string; since: string } };
  if (PHASE === "read") {
    const since = new Date();
    const WHO = process.env.WHO ?? "Elena Ruiz"; const MAIL = process.env.MAIL ?? "elena@a16z.example";
    const botId = `dr-${WHO.split(" ")[0].toLowerCase()}-${randomUUID()}`;
    // 1. Landing page: the introduction, exactly what /p/<shareId> posts.
    const landing = await fetch(`${APP}/api/share/${st.linkShareId}/landing`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify({ botId, viewerName: WHO, viewerEmail: MAIL }),
    });
    log("landing introduce", { status: landing.status, body: (await landing.text()).slice(0, 120) });
    // 2. Two documents, timing posts only (no name anywhere in the body).
    for (const [key, pages, secs] of [["model", 2, 35], ["deck", 3, 30]] as Array<[string, number, number]>) {
      const visitId = randomUUID();
      const t0 = Date.now();
      let total = 0;
      for (let p = 1; p <= pages; p += 1) {
        const body: Record<string, unknown> = { botId, visitId, docId: st.docs[key], pageNumber: p, enteredAtMs: t0, numPages: pages };
        if (p > 1) Object.assign(body, { durationMs: total, pageDurationMs: secs * 1000 });
        const r = await fetch(`${APP}/api/share/${st.linkShareId}/stats`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) });
        if (r.status !== 200) log(`stats ${key} p${p}`, { status: r.status });
        total += secs * 1000;
        await sleep(300);
      }
    }
    st.elena = { botId, since: since.toISOString() };
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
    await sleep(4000);
    const conns = await SlackConnectionModel.find({ orgId: new Types.ObjectId(ORG_ID) }).select({ channelName: 1 }).lean();
    const name = new Map(conns.map((c) => [String(c._id), c.channelName]));
    const posts = await SlackOutboxModel.find({ orgId: new Types.ObjectId(ORG_ID), createdDate: { $gte: since } }).lean();
    log("slack after reads", posts.map((p) => `${p.kind} -> ${name.get(String(p.connectionId))} [${p.status}] viewerName=${p.event?.viewerName ?? null}`));
  } else {
    const since = new Date(st.elena!.since);
    const wait = Number(process.argv[3] ?? 150);
    console.log(`waiting ${wait}s`);
    await sleep(wait * 1000);
    const cron = await fetch(`${APP}/api/cron/visit-briefs?workspaceId=${ORG_ID}`, { method: "POST" });
    const body = (await cron.json().catch(() => null)) as Record<string, unknown> | null;
    log("tick", { status: cron.status, claimed: body?.claimed, briefed: body?.briefed, recap: body?.recap, postponed: body?.postponed, skipped: body?.skipped });
    await sleep(6000);
    const rows = await VisitBriefModel.find({ orgId: new Types.ObjectId(ORG_ID), projectId: new Types.ObjectId(PROJECT_ID), createdDate: { $gte: since } }).select({ viewerName: 1, viewerEmail: 1, status: 1, recapReason: 1, "brief.headline": 1 }).lean();
    log("elena's brief rows", rows.map((b) => ({ who: b.viewerName, email: b.viewerEmail, status: b.status, reason: b.recapReason ?? null, headline: (b as { brief?: { headline?: string } }).brief?.headline ?? null })));
    const conns = await SlackConnectionModel.find({ orgId: new Types.ObjectId(ORG_ID) }).select({ channelName: 1 }).lean();
    const name = new Map(conns.map((c) => [String(c._id), c.channelName]));
    const posts = await SlackOutboxModel.find({ orgId: new Types.ObjectId(ORG_ID), createdDate: { $gte: since } }).sort({ createdDate: 1 }).lean();
    log("slack", posts.map((p) => `${p.kind} -> ${name.get(String(p.connectionId))} [${p.status}]`));
  }
  await mongoose.disconnect();
  await exit(0);
})().catch(async (e) => { console.error("FAILED", e instanceof Error ? e.message : e); await exit(1); });
