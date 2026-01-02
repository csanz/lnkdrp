#!/usr/bin/env node
/**
 * Backfill Doc.projectIds[] for docs that live inside request repos (Projects where isRequest=true).
 *
 * Why:
 * - Request uploads always set both `projectId` and `projectIds`, but older data / edge cases
 *   may only have `projectId`. This script ensures membership is consistent so the UI and
 *   filters behave correctly.
 *
 * Usage:
 *   node scripts/request-docs-projectids-backfill.mjs           # dry-run (prints summary only)
 *   node scripts/request-docs-projectids-backfill.mjs --apply  # writes updates
 *
 * Env (loaded automatically from .env.local):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional; uses default from URI if omitted)
 */
import process from "node:process";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

/**
 * Print usage instructions for request-docs-projectids-backfill.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/request-docs-projectids-backfill.mjs
  node scripts/request-docs-projectids-backfill.mjs --apply
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Run request-docs-projectids-backfill.mjs: Backfill Doc.projectIds[] for docs that live inside request repos (Projects where isRequest=true).
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
    const docsCol = db.collection("docs");

    const requestProjects = await projectsCol
      .find({ isRequest: true }, { projection: { _id: 1 } })
      .toArray();
    const requestProjectIds = requestProjects.map((p) => p._id).filter(Boolean);

    console.log(
      [
        `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
        `Request projects: ${requestProjectIds.length}`,
        apply ? "Mode: APPLY (writing changes)" : "Mode: DRY-RUN (no writes)",
      ].join("\n"),
    );

    if (!requestProjectIds.length) return;

    // Docs whose primary project is a request project but projectIds is missing or does not contain it.
    const needs = await docsCol.countDocuments({
      projectId: { $in: requestProjectIds },
      $or: [{ projectIds: { $exists: false } }, { projectIds: { $ne: null, $not: { $elemMatch: { $in: requestProjectIds } } } }],
    });

    console.log(`Docs needing projectIds backfill: ${needs}`);

    if (!apply || !needs) return;

    // Update in batches per projectId to avoid complex $expr updates.
    let modified = 0;
    for (const pid of requestProjectIds) {
      const res = await docsCol.updateMany(
        { projectId: pid },
        { $addToSet: { projectIds: pid } },
      );
      modified += res.modifiedCount || 0;
    }

    console.log(`Done. Updated docs: ${modified}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




