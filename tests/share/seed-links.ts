/**
 * Create a set of labelled share links on one document, through the MCP server.
 *
 * Deliberately through the agent path rather than straight into Mongo: `lnkdrp_create_share_link`
 * is how an agent does this in production, so seeding this way exercises the plan cap, the
 * validation, the activity rows and the default-link rules instead of writing around them. A seed
 * script that reaches past the API tests nothing and can leave a state the API would never produce.
 *
 * Each link gets an investor-style label and audience, because a links table whose rows read
 * "Link 1 … Link 10" cannot show whether the labels are legible at the widths they are given.
 *
 * Prerequisites:
 *   npm run dev   # Next app on :3001
 *   npm run mcp   # MCP server on :8787
 *
 * Run:
 *   npx tsx --env-file=.env.local tests/share/seed-links.ts --docId <id> --count 10
 *
 * Creates links and nothing else; it never deletes. On a Free workspace the cap applies, so links
 * past it are created **disabled** and reported as such — that is the API's behaviour, not a bug
 * in the seed.
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
 * Audiences a memo like this actually goes to, so the labels exercise realistic widths.
 *
 * Invented firms, deliberately: this seed fills the workspace the product screenshots are taken
 * from, and it named real funds, so a homepage shot ended up reading "viewed Cap Table via Sequoia".
 * Same list as `seed-corpus/content.ts`, which explains the rule at more length.
 */
const AUDIENCES = [
  { label: "Northwind", audience: "Northwind Ventures — growth team" },
  { label: "Harbourline", audience: "Harbourline Capital — partner intro" },
  { label: "Kestrel Row", audience: "Kestrel Row — Series B diligence" },
  { label: "Quillfield", audience: "Quillfield Capital" },
  { label: "Fathom Point", audience: "Fathom Point — London" },
  { label: "Board pre-read", audience: "Board, ahead of the Q4 meeting" },
  { label: "Stonemoor", audience: "Stonemoor Capital — first call" },
  { label: "Counsel", audience: "Outside counsel, diligence room" },
  { label: "Evermoor", audience: "Evermoor Partners — later stage" },
  { label: "Data room mirror", audience: "Shared data room copy" },
] as const;

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

async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content.find((c) => c.type === "text") : undefined;
  const text = block && block.type === "text" ? block.text : null;
  if (result.isError) throw new Error(`${name} failed: ${text ?? "unknown error"}`);
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as T;
  if (!text) throw new Error(`${name}: no result`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const pacing = resolvePacing();
  const count = Math.max(1, Math.min(AUDIENCES.length, Number(arg("count") ?? 10)));
  const docIdArg = arg("docId");
  if (!docIdArg || !Types.ObjectId.isValid(docIdArg)) throw new Error("--docId <id> is required");
  await connectMongo();

  const doc = (await DocModel.findById(new Types.ObjectId(docIdArg))
    .select({ _id: 1, title: 1, orgId: 1, userId: 1 })
    .lean()) as unknown as { _id: Types.ObjectId; title?: string; orgId?: Types.ObjectId; userId?: Types.ObjectId } | null;
  if (!doc) throw new Error(`no document ${docIdArg}`);
  const orgId = doc.orgId ? String(doc.orgId) : null;
  if (!orgId) throw new Error("document has no workspace");

  const owner = await OrgMembershipModel.findOne({ orgId: new Types.ObjectId(orgId), role: "owner", isDeleted: { $ne: true } })
    .select({ userId: 1 })
    .lean();
  const userId = owner ? String((owner as { userId: unknown }).userId) : doc.userId ? String(doc.userId) : null;
  if (!userId) throw new Error("no workspace member to mint a key for");

  const created = await createApiKey({ orgId, userId, name: `seed links ${new Date().toISOString()}`, scopes: ["read", "write"] });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${created.plaintext}` } },
  });
  const client = new Client({ name: "lnkdrp-seed", version: "1.0" });

  let madeCount = 0;
  let cappedCount = 0;
  try {
    await client.connect(transport);
    log(`document: ${doc.title} (${String(doc._id)})`);
    log(`creating ${count} links as an agent · ${describePacing(pacing)}`);
    log();

    for (let i = 0; i < count; i++) {
      const spec = AUDIENCES[i]!;
      if (i) await pause(pacing);
      const res = await callTool<{ link?: { shareId?: string; label?: string; enabled?: boolean }; planWarning?: unknown }>(
        client,
        "lnkdrp_create_share_link",
        { docId: String(doc._id), label: spec.label, audience: spec.audience },
      );
      const link = res.link ?? {};
      const capped = link.enabled === false;
      if (capped) cappedCount += 1;
      else madeCount += 1;
      log(`  ${String(spec.label).padEnd(18)} ${link.shareId ?? "?"}${capped ? "  (disabled — over the plan cap)" : ""}`);
    }
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      /* session already gone */
    }
    await client.close().catch(() => undefined);
    await revokeApiKey({ orgId, keyId: created.key.id });
  }

  log();
  log(`${madeCount} active, ${cappedCount} disabled by the plan cap. Key revoked.`);
  log(`Now generate traffic:`);
  log(`  npx tsx --env-file=.env.local tests/share/traffic.ts --docId ${String(doc._id)} --readers 20 --spread 10`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
