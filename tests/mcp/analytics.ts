/**
 * Read the share analytics through the MCP server, the way an agent does.
 *
 * Read-only: it mints a temporary read key, calls the two tools an agent uses to answer "how is
 * this deck doing", prints the answers side by side, and revokes the key. It creates no documents
 * and no links, so it is safe to point at any workspace including production.
 *
 * What it demonstrates, which is the thing that is easy to get wrong:
 *   - a `docId` alone asks about the **document** — every link's traffic added together;
 *   - a `docId` plus a `shareId` asks about **one link**, and every figure narrows to it;
 *   - the per-link figures add up to the document's, by construction;
 *   - on Free the tier is `basic` and viewer identities are withheld (recorded, not returned);
 *     on Pro the tier is `deep` and each viewer comes back with their pages and per-page time.
 *
 * Prerequisites:
 *   npm run dev   # Next app on :3001 (the MCP server calls its REST API)
 *   npm run mcp   # MCP server on :8787
 *
 * Run:
 *   npx tsx --env-file=.env.local tests/mcp/analytics.ts --doc "Live Audit Deck 3"
 *   npx tsx --env-file=.env.local tests/mcp/analytics.ts --docId <id> --days 30
 *
 * Pacing: calls are spaced 1.5-5s apart by default (`./pace.ts`); `--fast` removes the gaps.
 *
 * Env: MONGODB_URI (to mint and revoke the key, and to resolve --doc to an id),
 *      MCP_URL (default http://localhost:8787/mcp).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Types } from "mongoose";

import { describePacing, pause, resolvePacing } from "../pace";
import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { DocModel } from "@/lib/models/Doc";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
/**
 * Spacing between tool calls. This harness only reads, so nothing it does shows up in the activity
 * feed — but it is paced anyway so the MCP audit log shows an agent working through a document
 * rather than firing nine calls in one tick. `--fast` turns it off.
 */
const PACING = resolvePacing();

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

type Totals = {
  views?: number;
  /** Tab sessions: the count of opens, where `views` counts recipients. */
  opens?: number;
  /** `opens` is missing rows for older traffic, so it is a floor rather than a count. */
  opensPartial?: boolean;
  downloads?: number;
  pagesViewed?: number;
  timeSpentMs?: number;
  authenticatedViewers?: number;
  anonymousViewers?: number;
};
type Viewer = {
  name?: unknown;
  email?: unknown;
  views?: number;
  pagesViewed?: number;
  pagesSeen?: number[];
  timeSpentMs?: number;
  pageTimeMsByPage?: Record<string, number>;
  botIdHash?: string;
};

type Stats = {
  perLink?: boolean;
  shareId?: string | null;
  analyticsTier?: string;
  days?: number;
  viewerCount?: number;
  totals?: Totals;
  viewers?: Viewer[];
  anonymousViewers?: Viewer[];
};

/**
 * Unwrap an `untrusted()` envelope. Viewer-supplied names arrive as `{ _source, _note, text }` so a
 * model reading them cannot mistake a recipient's typed name for an instruction; printing the
 * object raw gave "[object Object]".
 */
function plain(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
  return null;
}

function secs(ms: unknown): string {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : 0;
  return `${Math.round(n / 1000)}s`;
}

function pageTime(map: Record<string, number> | undefined): string {
  if (!map || !Object.keys(map).length) return "";
  return Object.entries(map)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([p, ms]) => `p${p} ${secs(ms)}`)
    .join(", ");
}

function printViewers(s: Stats, indent = "    "): void {
  const rows = [
    ...(s.viewers ?? []).map((v) => ({ ...v, who: plain(v.name) || plain(v.email) || "signed-in viewer" })),
    ...(s.anonymousViewers ?? []).map((v) => ({ ...v, who: plain(v.name) || "anonymous reader" })),
  ];
  if (!rows.length) {
    log(
      s.analyticsTier === "deep"
        ? `${indent}(no reader opened this link in the window)`
        : `${indent}(tier "${s.analyticsTier}": identities are recorded but withheld on Free)`,
    );
    return;
  }
  for (const r of rows) {
    const pt = pageTime(r.pageTimeMsByPage);
    log(`${indent}${r.who}: pages [${(r.pagesSeen ?? []).join(",")}], ${secs(r.timeSpentMs)}${pt ? ` (${pt})` : ""}`);
  }
}

function printTotals(label: string, s: Stats): void {
  const t = s.totals ?? {};
  const views = t.views ?? 0;
  const opens = typeof t.opens === "number" && t.opensPartial !== true ? t.opens : null;
  // Opens beside views, because the gap between them is the only thing on this line that says
  // somebody came back: views counts recipients and opens counts sittings.
  const returns = opens !== null && opens > views ? ` (${opens - views} returned)` : "";
  log(
    `${label}  views ${views} · opens ${opens ?? (t.opensPartial ? "not tracked for older traffic" : "–")}${returns} · viewers ${s.viewerCount ?? 0} · ` +
      `pages ${t.pagesViewed ?? 0} · time ${secs(t.timeSpentMs)} · downloads ${t.downloads ?? 0}`,
  );
}

async function main(): Promise<void> {
  const days = Number(arg("days") ?? 30);
  await connectMongo();

  const docIdArg = arg("docId");
  const titleArg = arg("doc");
  const doc = docIdArg
    ? await DocModel.findById(new Types.ObjectId(docIdArg)).select({ _id: 1, orgId: 1, userId: 1, title: 1 }).lean()
    : await DocModel.findOne({ title: titleArg ?? /./, isDeleted: { $ne: true } })
        .sort({ createdDate: -1 })
        .select({ _id: 1, orgId: 1, userId: 1, title: 1 })
        .lean();
  if (!doc) throw new Error("no document matched; pass --docId or --doc <title>");
  const d = doc as unknown as { _id: Types.ObjectId; orgId?: Types.ObjectId; userId?: Types.ObjectId; title?: string };
  const orgId = d.orgId ? String(d.orgId) : null;
  if (!orgId) throw new Error("document has no workspace");

  // The key belongs to a real member: an agent acts as a person, never as the workspace.
  const owner = await OrgMembershipModel.findOne({ orgId: new Types.ObjectId(orgId), role: "owner", isDeleted: { $ne: true } })
    .select({ userId: 1 })
    .lean();
  const userId = owner ? String((owner as { userId: unknown }).userId) : d.userId ? String(d.userId) : null;
  if (!userId) throw new Error("no workspace member to mint a key for");

  const created = await createApiKey({ orgId, userId, name: `analytics read ${new Date().toISOString()}`, scopes: ["read"] });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } },
  });
  const client = new Client({ name: "lnkdrp-analytics", version: "1.0" });

  try {
    await client.connect(transport);
    log(`document: ${d.title} (${String(d._id)})`);
    log(`workspace: ${orgId} · window: last ${days} days · key ${created.key.prefix}… · ${describePacing(PACING)}`);
    log();

    const links = await callTool<{ links?: Array<{ shareId: string; label: string; status?: string }> }>(client, "lnkdrp_list_share_links", {
      docId: String(d._id),
    });
    const list = links.links ?? [];

    // 1. The document: every link added together.
    await pause(PACING);
    const all = await callTool<Stats>(client, "lnkdrp_get_share_stats", { docId: String(d._id), days, includeViewers: true });
    log(`ALL LINKS (perLink: ${String(all.perLink)}, tier: ${all.analyticsTier})`);
    printTotals("  ", all);
    printViewers(all, "    ");
    log();

    // 2. Each link on its own. Same tool, one extra argument.
    let sumViews = 0;
    let sumDownloads = 0;
    for (const l of list) {
      await pause(PACING);
      const one = await callTool<Stats>(client, "lnkdrp_get_share_stats", {
        docId: String(d._id),
        shareId: l.shareId,
        days,
        includeViewers: true,
      });
      sumViews += one.totals?.views ?? 0;
      sumDownloads += one.totals?.downloads ?? 0;
      log(`LINK "${l.label}" (${l.shareId}${l.status && l.status !== "active" ? `, ${l.status}` : ""}) perLink: ${String(one.perLink)}`);
      printTotals("  ", one);
      printViewers(one, "    ");
      log();
    }

    // 3. The invariant the metrics page relies on: the parts add up to the whole.
    const docViews = all.totals?.views ?? 0;
    const docDownloads = all.totals?.downloads ?? 0;
    log(`sum(links) views ${sumViews} vs document ${docViews} — ${sumViews === docViews ? "match" : "MISMATCH"}`);
    log(`sum(links) downloads ${sumDownloads} vs document ${docDownloads} — ${sumDownloads === docDownloads ? "match" : "MISMATCH"}`);
    if (sumViews !== docViews || sumDownloads !== docDownloads) process.exitCode = 1;
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      /* session already gone */
    }
    await client.close().catch(() => undefined);
    await revokeApiKey({ orgId, keyId: created.key.id });
    log(`\nkey revoked (${created.key.id})`);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
