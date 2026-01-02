#!/usr/bin/env node
/**
 * Recompute and backfill Project.docCount for all projects.
 *
 * This avoids runtime count lookups by maintaining a cached count on the Project record.
 *
 * Usage:
 *   node scripts/project-doc-count-recount.mjs           # dry-run (prints summary only)
 *   node scripts/project-doc-count-recount.mjs --apply  # writes updates
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
 * Print usage instructions for project-doc-count-recount.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/project-doc-count-recount.mjs
  node scripts/project-doc-count-recount.mjs --apply

Notes:
  - This script loads .env.local automatically.
  - Dry-run is the default; pass --apply to write changes.
  - Counts "active" docs only (isDeleted != true AND isArchived != true).
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Run project-doc-count-recount.mjs: Recompute and backfill Project.docCount for all projects.
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

    const projectTotal = await projectsCol.countDocuments({});

    // Aggregate counts of active docs per project, using membership union:
    // - legacy primary: projectId
    // - canonical membership: projectIds[]
    const counts = await docsCol
      .aggregate([
        { $match: { isDeleted: { $ne: true }, isArchived: { $ne: true } } },
        {
          $project: {
            _id: 0,
            projectRefs: {
              $setUnion: [
                {
                  $cond: [{ $ifNull: ["$projectId", false] }, ["$projectId"], []],
                },
                { $ifNull: ["$projectIds", []] },
              ],
            },
          },
        },
        { $unwind: "$projectRefs" },
        { $group: { _id: "$projectRefs", docCount: { $sum: 1 } } },
      ])
      .toArray();

    const nonZeroProjects = counts.length;
    const totalDocsInProjects = counts.reduce((sum, c) => sum + (Number.isFinite(c?.docCount) ? c.docCount : 0), 0);

    console.log(
      [
        `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
        `Projects: ${projectTotal}`,
        `Projects with >=1 active doc: ${nonZeroProjects}`,
        `Total active doc memberships counted: ${totalDocsInProjects}`,
        apply ? "Mode: APPLY (writing changes)" : "Mode: DRY-RUN (no writes)",
      ].join("\n"),
    );

    if (!apply) return;

    // Reset all counts to 0, then set non-zero counts.
    await projectsCol.updateMany({}, { $set: { docCount: 0 } });
    if (counts.length) {
      await projectsCol.bulkWrite(
        counts.map((c) => ({
          updateOne: {
            filter: { _id: c._id },
            update: { $set: { docCount: Number.isFinite(c.docCount) ? c.docCount : 0 } },
            upsert: false,
          },
        })),
      );
    }

    console.log("Done.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});




