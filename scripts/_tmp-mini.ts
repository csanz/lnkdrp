/** Mini drive (temporary): one new document, added to the Data room, one link. Prints feed vs Slack. */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { SlackOutboxModel } from "@/lib/models/SlackOutbox";
import { renderSlackEvent } from "@/lib/slack/messages";
import { exit } from "./lib/exit";

const ORG_ID = "6ab46f3add6983534677931d";
const USER_ID = "6ab46f3a542dc85d9d3ba00f";
const PROJECT_ID = "6ab694307102af9d9d25d6a6";
const TITLE = process.argv[2] ?? `Investor FAQ ${new Date().toISOString().slice(11, 16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const sc = (res as { structuredContent?: unknown }).structuredContent;
  if (sc) return sc as T;
  const text = ((res as { content?: Array<{ type: string; text?: string }> }).content ?? []).find((c) => c.type === "text")?.text ?? "{}";
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

(async () => {
  const since = new Date();
  await connectMongo();
  const created = await createApiKey({ orgId: ORG_ID, userId: USER_ID, name: `mini ${since.toISOString()}`, scopes: ["read", "write"] });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), { requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } } });
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  try {
    await client.connect(transport);
    const r = await call<{ docId: string }>(client, "lnkdrp_share_pdf", { idempotencyKey: `mini-${randomUUID()}`, title: TITLE, sourceUrl: "https://pdfobject.com/pdf/sample-3pp.pdf", waitForReady: true, timeoutSeconds: 120 });
    await sleep(2500);
    await call(client, "lnkdrp_add_docs_to_project", { projectId: PROJECT_ID, docIds: [r.docId] });
    await call(client, "lnkdrp_create_share_link", { docId: r.docId, label: "Angels", audience: "Angel syndicate" });
  } finally {
    await client.close().catch(() => {});
    await revokeApiKey({ orgId: ORG_ID, keyId: created.key.id }).catch(() => {});
  }
  await sleep(5000);
  const orgId = new Types.ObjectId(ORG_ID);
  const conns = await SlackConnectionModel.find({ orgId }).select({ channelName: 1 }).lean();
  const name = new Map(conns.map((c) => [String(c._id), c.channelName]));
  const posts = await SlackOutboxModel.find({ orgId, createdDate: { $gte: since } }).sort({ createdDate: 1 }).lean();
  const acts = await ActivityEventModel.find({ orgId, createdDate: { $gte: since } }).select({ type: 1 }).lean();
  console.log("ACTIVITY", acts.map((a) => a.type).join(", "));
  for (const p of posts) {
    const text = (await renderSlackEvent(p as never).catch(() => null))?.text ?? "(renders nothing)";
    console.log(`SLACK ${p.kind}${p.event?.change ? "/" + p.event.change : ""} -> ${name.get(String(p.connectionId))} [${p.status}${p.skippedReason ? " " + p.skippedReason : ""}] "${text}"`);
  }
  await exit(0);
})().catch(async (e) => { console.error("FAILED", e instanceof Error ? e.message : e); await exit(1); });
