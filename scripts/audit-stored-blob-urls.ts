/**
 * Read-only audit: does any stored URL point somewhere that is not our blob store?
 *
 * `Doc.blobUrl` and `Doc.previewImageUrl` used to be patchable from a request body, by any actor
 * including an unauthenticated temp user. That write path is closed — the fields are refused
 * outright now rather than validated — and the five routes that dereference them check the host and
 * refuse to follow a redirect off the store. So a poisoned row is harmless at serve time.
 *
 * What none of that tells you is whether a poisoned row exists. Nobody has looked, and the read-side
 * check has a visible cost when it fires: the owner of an affected document sees a permanent
 * "PDF not available" with nothing to explain it, and no support path short of re-uploading.
 *
 * This answers the question. It is the difference between "we believe the population is empty" and
 * "the population is empty", and those are not the same sentence to put in a security document.
 *
 * It also catches the duller cases that are not attacks at all: a row left pointing at a store that
 * was decommissioned, an `http://` URL from before the scheme was pinned, a value that is not a URL.
 * Those fail exactly the same way for the owner.
 *
 * Reads only. Safe against production and against a database another session is writing to.
 *
 * Usage:
 *   npm run audit:blob-urls                 # every live document
 *   npm run audit:blob-urls -- --all        # include archived and soft-deleted
 *   npm run audit:blob-urls -- --ids        # print the document ids, not just counts
 *
 * Exit code is 1 when anything is off the store, so it works as a pre-deploy gate.
 */
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { blobFetchUrl } from "@/lib/blob/fetchStoredBlob";

type Row = { _id: unknown; blobUrl?: unknown; previewImageUrl?: unknown; firstPagePngUrl?: unknown; orgId?: unknown };

/** The fields that are dereferenced by a public route, and therefore the ones that matter. */
const FIELDS = ["blobUrl", "previewImageUrl", "firstPagePngUrl"] as const;

type Finding = { id: string; orgId: string | null; field: string; value: string; why: string };

/**
 * Why this value would be refused, or null when it is fine.
 *
 * Deliberately asks `blobFetchUrl` rather than re-deriving the rule: the point of the audit is to
 * report what the serving path would actually do, so a second opinion about what "ours" means would
 * make the answer wrong in exactly the case that matters.
 */
function refusalReason(value: unknown): { value: string; why: string } | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return { value: String(value), why: "not a string" };
  if (blobFetchUrl(value)) return null;

  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    return { value, why: "not a URL" };
  }
  if (parsed.protocol !== "https:") return { value, why: `scheme is ${parsed.protocol}` };
  return { value, why: `host is ${parsed.hostname}` };
}

async function main() {
  const argv = process.argv.slice(2);
  const includeAll = argv.includes("--all");
  const showIds = argv.includes("--ids");

  await connectMongo();

  const filter: Record<string, unknown> = includeAll ? {} : { isDeleted: { $ne: true }, isArchived: { $ne: true } };
  const findings: Finding[] = [];
  let scanned = 0;
  let withAnyPointer = 0;

  const cursor = DocModel.find(filter)
    .select({ blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1, orgId: 1 })
    .lean()
    .cursor();

  for await (const raw of cursor) {
    const row = raw as Row;
    scanned += 1;
    const id = String(row._id);
    const orgId = row.orgId ? String(row.orgId) : null;
    let hadPointer = false;
    for (const field of FIELDS) {
      const value = (row as Record<string, unknown>)[field];
      if (typeof value === "string" && value) hadPointer = true;
      const bad = refusalReason(value);
      if (bad) findings.push({ id, orgId, field, value: bad.value, why: bad.why });
    }
    if (hadPointer) withAnyPointer += 1;
  }

  // Uploads carry the same two fields and feed the document's, so a bad row here is where a bad
  // document row would come from next.
  let uploadFindings = 0;
  const uploadCursor = UploadModel.find(includeAll ? {} : { isDeleted: { $ne: true } })
    .select({ blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1 })
    .lean()
    .cursor();
  for await (const raw of uploadCursor) {
    for (const field of FIELDS) {
      const bad = refusalReason((raw as Record<string, unknown>)[field]);
      if (bad) {
        uploadFindings += 1;
        if (showIds) findings.push({ id: `upload:${String((raw as Row)._id)}`, orgId: null, field, value: bad.value, why: bad.why });
      }
    }
  }

  const byReason = new Map<string, number>();
  for (const f of findings) byReason.set(f.why, (byReason.get(f.why) ?? 0) + 1);

  console.log(`documents scanned: ${scanned} (${withAnyPointer} carry at least one stored pointer)`);
  console.log(`document values off the store: ${findings.filter((f) => !f.id.startsWith("upload:")).length}`);
  console.log(`upload values off the store: ${uploadFindings}`);

  if (byReason.size) {
    console.log("\nby reason:");
    for (const [why, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${why}`);
    }
  }

  if (showIds && findings.length) {
    console.log("\nrows:");
    // The value is printed because the whole point is to see where it pointed. These are rows an
    // operator already has full access to, and a poisoned one is evidence.
    for (const f of findings) {
      console.log(`  ${f.id}  ${f.field}  ${f.why}  ${f.value.slice(0, 160)}`);
    }
  } else if (findings.length) {
    console.log("\nre-run with --ids to see which rows.");
  }

  const total = findings.filter((f) => !f.id.startsWith("upload:")).length + uploadFindings;
  if (total === 0) {
    console.log("\nnothing off the store. The population is empty, which is the answer docs/SECURITY.md was missing.");
    return;
  }
  console.log(`\n${total} value(s) would be refused at serve time. Owners of those documents see "not available".`);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The script is read-only, so there is nothing to flush; exit rather than hold the pool open.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
