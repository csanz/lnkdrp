/**
 * Delete AI runs and request repos, and nothing else.
 *
 *   npm run mongo:clear:ai-runs-requests -- --dry-run
 *   npm run mongo:clear:ai-runs-requests -- --yes
 *
 * The scoped counterpart to `npm run reset`: that one empties the database, this one clears the
 * two collections you actually want back to zero when re-testing the AI and request flows, leaving
 * your documents, uploads and workspace alone.
 *
 * It refuses to run against anything but a database on this machine. It used to be a `.mjs` run by
 * bare `node` with no such check, next to a second unguarded script that dropped *every*
 * collection - `MONGODB_URI=<atlas uri> npm run mongo:clear -- --all` was a working command. The
 * nuclear one is gone (`npm run reset` supersedes it); this one keeps its scope and borrows that
 * command's guard rather than growing a second copy of it. See `src/lib/db/localTarget.ts` for what
 * counts as local - `mongodb+srv://` never does, and in a replica-set URI every host has to be.
 */
import "dotenv/config";
import mongoose from "mongoose";

import { isLocalMongoTarget } from "@/lib/db/localTarget";

/** Projects that are request repos rather than ordinary projects. */
const REQUEST_PROJECTS = { $or: [{ isRequest: true }, { requestUploadToken: { $type: "string" } }] };

function usage(exitCode = 1): never {
  console.error(
    [
      "Usage:",
      "  npm run mongo:clear:ai-runs-requests -- --dry-run",
      "  npm run mongo:clear:ai-runs-requests -- --yes",
      "",
      "Clears the `airuns` collection and request-repo `projects`. Nothing else is touched.",
      "Only ever runs against a database on this machine.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const dryRun = args.has("--dry-run");
  if (!dryRun && !args.has("--yes")) {
    console.error('Refusing to run: pass "--yes" (or use --dry-run).');
    usage(1);
  }

  const uri = (process.env.MONGODB_URI ?? "").trim();
  const verdict = isLocalMongoTarget(uri);
  if (!verdict.local) {
    console.error("\n  Refusing to clear.");
    console.error(`  ${verdict.reason}`);
    console.error("\n  This command only ever deletes from a database on this machine.\n");
    process.exit(1);
  }

  const dbName = (process.env.MONGODB_DB_NAME ?? "").trim() || undefined;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 });

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("No database handle after connecting.");

    const aiRuns = await db.collection("airuns").countDocuments({});
    const requests = await db.collection("projects").countDocuments(REQUEST_PROJECTS);

    console.log("");
    console.log(`  target     ${verdict.hosts.join(", ")} / ${dbName ?? "(from URI)"}`);
    console.log(`  airuns     ${aiRuns}`);
    console.log(`  requests   ${requests}`);

    if (dryRun) {
      console.log("\n  --dry-run: nothing was deleted.\n");
      return;
    }

    const runs = await db.collection("airuns").deleteMany({});
    const projects = await db.collection("projects").deleteMany(REQUEST_PROJECTS);
    console.log(`\n  deleted    ${runs.deletedCount ?? 0} airuns, ${projects.deletedCount ?? 0} request projects\n`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
