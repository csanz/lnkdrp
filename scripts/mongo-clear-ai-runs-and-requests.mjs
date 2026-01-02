#!/usr/bin/env node
/**
 * Danger: delete AI runs + request repos (ONLY) from MongoDB.
 *
 * Usage:
 *   node scripts/mongo-clear-ai-runs-and-requests.mjs --dry-run
 *   node scripts/mongo-clear-ai-runs-and-requests.mjs --yes
 *
 * Notes:
 * - Loads `.env.local` automatically.
 * - Deletes:
 *   - `airuns` collection (all documents)
 *   - `projects` documents that look like request repos (`isRequest=true` OR `requestUploadToken` exists)
 * - Does NOT delete docs/uploads/reviews; if you want a full request reset, we can add it.
 */
import process from "node:process";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/mongo-clear-ai-runs-and-requests.mjs --dry-run
  node scripts/mongo-clear-ai-runs-and-requests.mjs --yes

Env (loaded automatically from .env.local):
  - MONGODB_URI (required)
  - MONGODB_DB_NAME (optional; uses default from URI if omitted)
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const dryRun = args.has("--dry-run");
  const yes = args.has("--yes");
  if (!dryRun && !yes) {
    console.error('Refusing to run: pass "--yes" (or use --dry-run).');
    usage(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error(
      [
        "Missing MONGODB_URI.",
        "Add it to .env.local (this script loads .env.local automatically).",
        "",
        'Example: MONGODB_URI="mongodb://localhost:27017/mydb"',
      ].join("\n"),
    );
    process.exit(1);
  }
  const dbName = process.env.MONGODB_DB_NAME;

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("No db handle after connecting.");

    const requestProjectFilter = {
      $or: [{ isRequest: true }, { requestUploadToken: { $type: "string" } }],
    };

    const aiRunsCount = await db.collection("airuns").countDocuments({});
    const requestProjectsCount = await db.collection("projects").countDocuments(requestProjectFilter);

    console.log(
      [
        `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
        `Would delete: airuns=${aiRunsCount}, request projects=${requestProjectsCount}`,
        dryRun ? "(dry-run; no changes will be made)" : "(deleting now)",
      ].join(" "),
    );

    if (dryRun) return;

    const aiRunsRes = await db.collection("airuns").deleteMany({});
    const projectsRes = await db.collection("projects").deleteMany(requestProjectFilter);

    console.log(`Deleted airuns: ${aiRunsRes.deletedCount ?? 0}`);
    console.log(`Deleted request projects: ${projectsRes.deletedCount ?? 0}`);
    console.log("Done.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




