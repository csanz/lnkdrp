#!/usr/bin/env node
/**
 * Backfill Doc.receivedViaRequestProjectId for docs that were received via request repos.
 *
 * Heuristic:
 * - If doc.receivedViaRequestProjectId is missing/null AND:
 *   - doc.projectId is a request project => set to doc.projectId
 *   - else if doc.projectIds contains any request project => set to the first such projectId
 *
 * Usage:
 *   node scripts/doc-received-via-request-backfill.mjs           # dry-run (prints summary only)
 *   node scripts/doc-received-via-request-backfill.mjs --apply  # writes updates
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
 * Print usage instructions for doc-received-via-request-backfill.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/doc-received-via-request-backfill.mjs
  node scripts/doc-received-via-request-backfill.mjs --apply
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Run doc-received-via-request-backfill.mjs: Backfill Doc.receivedViaRequestProjectId for docs that were received via request repos.
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

    const baseFilter = {
      $or: [{ receivedViaRequestProjectId: { $exists: false } }, { receivedViaRequestProjectId: null }],
      isDeleted: { $ne: true },
    };

    const needsPrimary = await docsCol.countDocuments({
      ...baseFilter,
      projectId: { $in: requestProjectIds },
    });
    const needsMembership = await docsCol.countDocuments({
      ...baseFilter,
      projectId: { $nin: requestProjectIds },
      projectIds: { $in: requestProjectIds },
    });

    console.log(`Docs needing backfill (primary request project): ${needsPrimary}`);
    console.log(`Docs needing backfill (membership request project): ${needsMembership}`);
    console.log(`Total needing backfill: ${needsPrimary + needsMembership}`);

    if (!apply || !(needsPrimary + needsMembership)) return;

    let updated = 0;

    // 1) If projectId is a request project, set receivedViaRequestProjectId = projectId.
    {
      const res = await docsCol.updateMany(
        {
          ...baseFilter,
          projectId: { $in: requestProjectIds },
        },
        [{ $set: { receivedViaRequestProjectId: "$projectId" } }],
      );
      updated += res.modifiedCount || 0;
    }

    // 2) Otherwise, set to the first request project found in projectIds.
    // Use an aggregation pipeline update to compute it.
    {
      const res = await docsCol.updateMany(
        {
          ...baseFilter,
          projectId: { $nin: requestProjectIds },
          projectIds: { $in: requestProjectIds },
        },
        [
          {
            $set: {
              receivedViaRequestProjectId: {
                $first: {
                  $filter: {
                    input: "$projectIds",
                    as: "pid",
                    cond: { $in: ["$$pid", requestProjectIds] },
                  },
                },
              },
            },
          },
        ],
      );
      updated += res.modifiedCount || 0;
    }

    console.log(`Done. Updated docs: ${updated}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});


