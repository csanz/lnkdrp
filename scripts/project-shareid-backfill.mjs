#!/usr/bin/env node
/**
 * Backfill Project.shareId for all projects missing one.
 *
 * Share IDs are public slugs used for `/p/:shareId`.
 *
 * Usage:
 *   node scripts/project-shareid-backfill.mjs           # dry-run (prints summary only)
 *   node scripts/project-shareid-backfill.mjs --apply  # writes updates
 *
 * Env (loaded automatically from .env.local):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional; uses default from URI if omitted)
 */
import process from "node:process";
import crypto from "node:crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

/**
 * Print usage instructions for project-shareid-backfill.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/project-shareid-backfill.mjs
  node scripts/project-shareid-backfill.mjs --apply

Notes:
  - This script loads .env.local automatically.
  - Dry-run is the default; pass --apply to write changes.
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * New Share Id.
 */

function newShareId() {
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * Run project-shareid-backfill.mjs: Backfill Project.shareId for all projects missing one.
 */

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const apply = args.has("--apply");

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

    const projectsCol = db.collection("projects");

    const total = await projectsCol.countDocuments({});
    const missing = await projectsCol.countDocuments({
      $or: [{ shareId: { $exists: false } }, { shareId: null }, { shareId: "" }],
    });

    console.log(
      [
        `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
        `Projects: ${total}`,
        `Projects missing shareId: ${missing}`,
        apply ? "Mode: APPLY (writing changes)" : "Mode: DRY-RUN (no writes)",
      ].join("\n"),
    );

    if (!apply || !missing) return;

    const cursor = projectsCol.find(
      { $or: [{ shareId: { $exists: false } }, { shareId: null }, { shareId: "" }] },
      { projection: { _id: 1 } },
    );

    let updated = 0;
    while (await cursor.hasNext()) {
      const p = await cursor.next();
      if (!p?._id) continue;

      // Retry a few times in the extremely unlikely event of a collision.
      let ok = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const shareId = newShareId();
        try {
          const res = await projectsCol.updateOne(
            {
              _id: p._id,
              $or: [{ shareId: { $exists: false } }, { shareId: null }, { shareId: "" }],
            },
            { $set: { shareId } },
          );
          if (res.modifiedCount) {
            updated++;
          }
          ok = true;
          break;
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? e.code : null;
          // 11000 = duplicate key; retry.
          if (code === 11000) continue;
          throw e;
        }
      }
      if (!ok) throw new Error("Failed to generate a unique shareId after 5 attempts.");
    }

    console.log(`Done. Updated: ${updated}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




