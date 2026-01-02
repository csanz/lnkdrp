#!/usr/bin/env node
/**
 * Danger: destructive MongoDB cleanup utilities.
 *
 * Usage:
 *   # (1) Nuclear option: drop ALL collections
 *   npm run mongo:clear -- --all
 *
 *   # (2) Scoped option: delete ALL non-personal orgs ("team" orgs) and their data
 *   npm run mongo:clear -- --orgs --all
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
 * Print usage instructions for mongo-clear.mjs and exit.
 */

function usage(exitCode = 1) {
  const msg = `
Usage:
  # Drop ALL collections (nuclear)
  npm run mongo:clear -- --all

  # Delete ALL non-personal orgs (type="team") and their related data
  npm run mongo:clear -- --orgs --all
  npm run mongo:clear -- --orgs   # (dry-run; counts only)

Notes:
  - This script loads .env.local automatically.
  - For destructive actions, pass --all as the confirmation flag.
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

/**
 * Chunk an array into slices of at most `size`.
 */
function chunk(arr, size) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function countByIn(db, collectionName, field, ids) {
  if (!ids?.length) return 0;
  let total = 0;
  for (const part of chunk(ids, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    total += await db.collection(collectionName).countDocuments({ [field]: { $in: part } });
  }
  return total;
}

async function deleteByIn(db, collectionName, field, ids) {
  if (!ids?.length) return 0;
  let total = 0;
  for (const part of chunk(ids, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await db.collection(collectionName).deleteMany({ [field]: { $in: part } });
    total += res?.deletedCount ?? 0;
  }
  return total;
}

/**
 * Mode: delete ALL non-personal orgs ("team" orgs) and their related data.
 */
async function clearTeamOrgs({ db, dbName, doDelete }) {
  const orgs = db.collection("orgs");

  const teamOrgIds = await orgs
    .find({ type: "team" }, { projection: { _id: 1 } })
    .map((o) => o?._id)
    .toArray();

  const orgCount = teamOrgIds.length;
  if (!orgCount) {
    console.log(`Connected${dbName ? ` (dbName=${dbName})` : ""}. No team orgs found. Nothing to do.`);
    return;
  }

  const projectsCol = db.collection("projects");
  const docsCol = db.collection("docs");
  const uploadsCol = db.collection("uploads");

  const projectIds = await projectsCol
    .find({ orgId: { $in: teamOrgIds } }, { projection: { _id: 1 } })
    .map((p) => p?._id)
    .toArray();
  const docIds = await docsCol
    .find({ orgId: { $in: teamOrgIds } }, { projection: { _id: 1 } })
    .map((d) => d?._id)
    .toArray();
  const uploadIds = await uploadsCol
    .find({ orgId: { $in: teamOrgIds } }, { projection: { _id: 1 } })
    .map((u) => u?._id)
    .toArray();

  const reviewIds = await db
    .collection("reviews")
    .find(docIds.length ? { docId: { $in: docIds } } : { _id: { $in: [] } }, { projection: { _id: 1 } })
    .map((r) => r?._id)
    .toArray();

  const counts = {
    orgs: orgCount,
    orgmemberships: await countByIn(db, "orgmemberships", "orgId", teamOrgIds),
    projects: projectIds.length,
    docs: docIds.length,
    uploads: uploadIds.length,
    projectviews: await countByIn(db, "projectviews", "projectId", projectIds),
    projectclicks: await countByIn(db, "projectclicks", "projectId", projectIds),
    shareviews: await countByIn(db, "shareviews", "docId", docIds),
    docreports: await countByIn(db, "docreports", "docId", docIds),
    reviews: reviewIds.length,
    airuns: await (async () => {
      // Count in chunks by OR filters to keep queries manageable.
      const col = db.collection("airuns");
      let total = 0;
      for (const docPart of chunk(docIds, 1_000)) {
        // eslint-disable-next-line no-await-in-loop
        total += await col.countDocuments({ docId: { $in: docPart } });
      }
      for (const uploadPart of chunk(uploadIds, 1_000)) {
        // eslint-disable-next-line no-await-in-loop
        total += await col.countDocuments({ uploadId: { $in: uploadPart } });
      }
      for (const reviewPart of chunk(reviewIds, 1_000)) {
        // eslint-disable-next-line no-await-in-loop
        total += await col.countDocuments({ reviewId: { $in: reviewPart } });
      }
      for (const projPart of chunk(projectIds, 1_000)) {
        // eslint-disable-next-line no-await-in-loop
        total += await col.countDocuments({ projectId: { $in: projPart } });
        // eslint-disable-next-line no-await-in-loop
        total += await col.countDocuments({ projectIds: { $in: projPart } });
      }
      return total;
    })(),
  };

  console.log(
    [
      `Connected${dbName ? ` (dbName=${dbName})` : ""}.`,
      `Team org wipe: orgs=${counts.orgs}, memberships=${counts.orgmemberships}, projects=${counts.projects}, docs=${counts.docs}, uploads=${counts.uploads}.`,
      `Dependents: projectviews=${counts.projectviews}, projectclicks=${counts.projectclicks}, shareviews=${counts.shareviews}, docreports=${counts.docreports}, reviews=${counts.reviews}, airuns=${counts.airuns}.`,
      doDelete ? "(deleting now)" : "(dry-run; no changes will be made)",
    ].join(" "),
  );

  if (!doDelete) return;

  // Delete dependents first.
  const deleted = {};
  deleted.projectviews = await deleteByIn(db, "projectviews", "projectId", projectIds);
  deleted.projectclicks = await deleteByIn(db, "projectclicks", "projectId", projectIds);
  deleted.shareviews = await deleteByIn(db, "shareviews", "docId", docIds);
  deleted.docreports = await deleteByIn(db, "docreports", "docId", docIds);
  deleted.reviews = await deleteByIn(db, "reviews", "_id", reviewIds);

  // airuns: delete by multiple linkage fields.
  const airunsCol = db.collection("airuns");
  let airunsDeleted = 0;
  for (const docPart of chunk(docIds, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    airunsDeleted += (await airunsCol.deleteMany({ docId: { $in: docPart } }))?.deletedCount ?? 0;
  }
  for (const uploadPart of chunk(uploadIds, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    airunsDeleted += (await airunsCol.deleteMany({ uploadId: { $in: uploadPart } }))?.deletedCount ?? 0;
  }
  for (const reviewPart of chunk(reviewIds, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    airunsDeleted += (await airunsCol.deleteMany({ reviewId: { $in: reviewPart } }))?.deletedCount ?? 0;
  }
  for (const projPart of chunk(projectIds, 1_000)) {
    // eslint-disable-next-line no-await-in-loop
    airunsDeleted += (await airunsCol.deleteMany({ projectId: { $in: projPart } }))?.deletedCount ?? 0;
    // eslint-disable-next-line no-await-in-loop
    airunsDeleted += (await airunsCol.deleteMany({ projectIds: { $in: projPart } }))?.deletedCount ?? 0;
  }
  deleted.airuns = airunsDeleted;

  // Delete primary org-scoped collections.
  deleted.uploads = await deleteByIn(db, "uploads", "orgId", teamOrgIds);
  deleted.docs = await deleteByIn(db, "docs", "orgId", teamOrgIds);
  deleted.projects = await deleteByIn(db, "projects", "orgId", teamOrgIds);
  deleted.orgmemberships = await deleteByIn(db, "orgmemberships", "orgId", teamOrgIds);
  deleted.orgs = await deleteByIn(db, "orgs", "_id", teamOrgIds);

  console.log("Deleted:");
  for (const [k, v] of Object.entries(deleted)) console.log(`- ${k}: ${v}`);
  console.log("Done.");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const wantsOrgWipe = args.has("--orgs");
  const confirmAll = args.has("--all");

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

    if (wantsOrgWipe) {
      await clearTeamOrgs({ db, dbName, doDelete: confirmAll });
      if (!confirmAll) {
        console.error('Refusing to delete: pass "--all" to delete team orgs (dry-run only).');
        process.exit(1);
      }
      return;
    }

    // Default mode: drop ALL collections (nuclear).
    if (!confirmAll) {
      console.error('Refusing to run: pass "--all" to drop ALL collections (or pass --orgs for scoped wipe).');
      usage(1);
    }

    const collections = await db.listCollections().toArray();
    const toDrop = collections
      .map((c) => c?.name)
      .filter((name) => typeof name === "string" && name.length > 0)
      .filter((name) => !name.startsWith("system."));

    console.log(
      `Connected. Dropping ${toDrop.length} collections` +
        (dbName ? ` (dbName=${dbName})` : "") +
        "...",
    );

    for (const name of toDrop) {
      await db.dropCollection(name);
      console.log(`- dropped: ${name}`);
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






