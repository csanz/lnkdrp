/**
 * What a Free workspace is actually told, driven through the MCP.
 *
 * Every plan gate has unit coverage, and none of it had been exercised live since the workspace
 * was upgraded to Pro. The gates are the part a new user meets first, and two of them were wrong
 * earlier tonight: `plan_limit` reported the count the refused write would have reached rather than
 * the one the workspace holds, and `capabilities.collaborators` counted the owner against a limit
 * that excludes them. Both were fixed against unit tests; this is the first time either is checked
 * against a running server.
 *
 * It mints its own key for a Free workspace, works inside that workspace only, and revokes the key
 * at the end. Documents it creates are deleted; the cap is reached on purpose and then released.
 *
 * Prerequisites (two terminals):
 *   npm run dev        # :3001, the REST API the MCP server calls
 *   npm run mcp        # :8787
 *
 * Run: npx tsx --env-file=.env.local tests/mcp/freeplan.ts
 *
 * Env: MONGODB_URI (to mint and revoke the key), MCP_URL (default http://localhost:8787/mcp),
 *      FREE_PDF_URL / FREE_PDF_PATH to choose the probe file.
 */
import { connectMongo } from "@/lib/mongodb";
import { createApiKey, revokeApiKey } from "@/lib/agents/apiKeys";
import { OrgModel } from "@/lib/models/Org";
import { getWorkspacePlan } from "@/lib/billing/planLimits";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8787/mcp";
/**
 * Any small PDF will do; this one is fetched rather than kept in the repo, the way e2e.ts does it.
 * Override with FREE_PDF_URL, or point FREE_PDF_PATH at a local file for an offline run.
 */
const PDF_URL = process.env.FREE_PDF_URL ?? "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const PDF_PATH = process.env.FREE_PDF_PATH ?? null;

const pass: string[] = [];
const fail: string[] = [];

/** One assertion, printed as it is made. */
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `   expected ${JSON.stringify(want)}`}`);
}

let session: string | null = null;

/** One JSON-RPC call, carrying the session id the server hands back at initialize. */
async function rpc(key: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(180_000),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid && !session) session = sid;
  const raw = await res.text();
  for (const line of raw.split("\n")) if (line.startsWith("data: ")) return JSON.parse(line.slice(6)) as Record<string, unknown>;
  return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

type ToolAnswer = { ok: boolean; body: Record<string, unknown> };

/** One tool call, unwrapped into `{ ok, body }` so a refusal is data rather than a throw. */
async function call(key: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const res = (await rpc(key, "tools/call", { name, arguments: args })).result as
    | { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }
    | undefined;
  if (!res) return { ok: false, body: {} };
  if (res.isError) {
    try {
      return { ok: false, body: JSON.parse(res.content?.[0]?.text ?? "{}").error as Record<string, unknown> };
    } catch {
      return { ok: false, body: {} };
    }
  }
  return { ok: true, body: res.structuredContent ?? {} };
}

/** Mint a key on a Free workspace, walk its gates, clean up, revoke. */
async function main(): Promise<void> {
  await connectMongo();

  // The newest Free personal workspace with an owner, so the key resolves to a real member.
  const orgs = await OrgModel.find({ isDeleted: { $ne: true }, personalForUserId: { $ne: null } })
    .select({ _id: 1, personalForUserId: 1 })
    .sort({ _id: -1 })
    .limit(20)
    .lean();
  let target: { orgId: string; userId: string } | null = null;
  for (const o of orgs) {
    if ((await getWorkspacePlan(String(o._id))) === "free") {
      target = { orgId: String(o._id), userId: String((o as { personalForUserId?: unknown }).personalForUserId) };
      break;
    }
  }
  if (!target) {
    console.log("no Free workspace to test against");
    process.exit(1);
  }
  console.log(`Free workspace ${target.orgId} (owner ${target.userId})\n`);

  const created = await createApiKey({ orgId: target.orgId, userId: target.userId, name: `freeplan ${new Date().toISOString()}`, scopes: ["read", "write"] });
  const key = created.plaintext;
  const madeDocs: string[] = [];
  try {
    await rpc(key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "freeplan", version: "1" } });
    await rpc(key, "notifications/initialized");

    console.log("=== what whoami tells a Free workspace ===");
    const me = (await call(key, "lnkdrp_whoami", {})).body as {
      plan?: string;
      capabilities?: Record<string, Record<string, unknown> | boolean | number | null>;
    };
    const caps = me.capabilities ?? {};
    check("plan", me.plan, "free");
    check("projectLinks", caps.projectLinks, { proOnly: true, available: false });
    check("deepAnalytics", caps.deepAnalytics, false);
    check("recipientsCanBrowseVersions", caps.recipientsCanBrowseVersions, false);
    check("analyticsDaysLimit is clamped", typeof caps.analyticsDaysLimit === "number", true);
    check("links are never capped", caps.links, { limited: false });
    // The round-two fix: `limit` excludes the owner, so `used` has to as well.
    const collab = caps.collaborators as Record<string, unknown>;
    check("collaborators.used counts collaborators, not members", collab?.used, 0);
    check("collaborators.members is the raw head count", collab?.members, 1);

    console.log("\n=== the Pro-only gate refuses before it is tried ===");
    const docs = caps.documents as Record<string, number | boolean>;
    const room = await call(key, "lnkdrp_create_project", { idempotencyKey: `free-room-${Date.now()}`, name: `Free probe ${Date.now()}` });
    if (room.ok) {
      const projectId = (room.body.project as { projectId: string }).projectId;
      const link = await call(key, "lnkdrp_create_project_link", { projectId, label: "Should be refused" });
      check("create_project_link is refused on Free", link.body.code, "plan_limit");
      check("the refusal names what still works", Array.isArray((link.body.details as Record<string, unknown>)?.alternatives), true);
      await call(key, "lnkdrp_delete_project", { projectId, confirm: true });
    } else {
      console.log(`  info could not create a probe project: ${JSON.stringify(room.body).slice(0, 120)}`);
    }

    console.log("\n=== the document cap, reached on purpose ===");
    const limit = Number(docs?.limit ?? 0);
    const already = Number(docs?.used ?? 0);
    console.log(`  info limit ${limit}, already used ${already}`);
    let refusal: Record<string, unknown> | null = null;
    for (let i = already; i < limit + 1; i++) {
      const r = await call(key, "lnkdrp_share_pdf", {
        idempotencyKey: `free-cap-${Date.now()}-${i}`,
        ...(PDF_PATH ? { filePath: PDF_PATH } : { sourceUrl: PDF_URL }),
        title: `[free] probe ${i + 1}`,
        summary: "A one page probe used to walk a Free workspace up to its document cap and read the refusal it gets at the top.",
        keyPoints: ["Reaching the cap on purpose", "Checking what the refusal reports"],
        waitForReady: true,
        timeoutSeconds: 120,
      });
      if (r.ok) {
        madeDocs.push(String(r.body.docId));
        continue;
      }
      refusal = r.body;
      break;
    }
    if (refusal) {
      check("the cap refuses with plan_limit", refusal.code, "plan_limit");
      const d = (refusal.details ?? {}) as Record<string, unknown>;
      // The round-two fix, live: `used` is what the workspace HOLDS. It reported the count the
      // refused write would have reached, which is a state it was never in.
      check("used is what the workspace holds", d.used, limit);
      check("max is the cap", d.max, limit);
      check("requested is what was asked for", d.requested, 1);
      check("the refusal names alternatives", Array.isArray(d.alternatives), true);
    } else {
      fail.push("never reached the document cap");
      console.log("  FAIL never reached the document cap");
    }

    console.log("\n=== archiving frees a slot, which is what the refusal promises ===");
    if (madeDocs.length) {
      await call(key, "lnkdrp_archive_doc", { docId: madeDocs[0]!, archived: true, confirm: true });
      const after = (await call(key, "lnkdrp_whoami", {})).body as { capabilities?: Record<string, Record<string, number | boolean>> };
      check("atLimit clears after archiving", after.capabilities?.documents?.atLimit, false);
    }

    console.log("\n=== Free analytics are clamped and anonymous ===");
    if (madeDocs.length > 1) {
      const stats = (await call(key, "lnkdrp_get_share_stats", { docId: madeDocs[1]!, days: 60, includeViewers: true })).body;
      check("analyticsTier", stats.analyticsTier, "basic");
      check("days clamped below the 60 asked for", Number(stats.days) < 60, true);
      check("no signed-in viewer rows on Free", stats.viewers, undefined);
      check("no anonymous viewer rows on Free", stats.anonymousViewers, undefined);
    }
  } finally {
    for (const id of madeDocs) await call(key, "lnkdrp_delete_doc", { docId: id, confirm: true }).catch(() => undefined);
    await revokeApiKey({ orgId: target.orgId, keyId: created.key.id }).catch(() => undefined);
    console.log(`\ncleaned up ${madeDocs.length} probe documents and revoked the key`);
  }

  console.log(`\npassed=${pass.length} failed=${fail.length}`);
  if (fail.length) for (const f of fail) console.log(`  FAILED: ${f}`);
  process.exit(fail.length ? 1 : 0);
}

void main();
