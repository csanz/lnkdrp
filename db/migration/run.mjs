#!/usr/bin/env node
/**
 * Migration runner (MongoDB/Mongoose).
 *
 * Usage:
 *   node db/migration/run.mjs [--dry-run]
 *
 * Notes:
 * - Loads `.env.local` automatically (same convention as scripts/mongo-clear.mjs).
 * - Runs migrations in filename sort order.
 * - Tracks applied migrations in the `migrations` collection.
 */
import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

function usage(exitCode = 1) {
  const msg = `
Usage:
  node db/migration/run.mjs [--dry-run]

Env (loaded automatically from .env.local):
  - MONGODB_URI (required)
  - MONGODB_DB_NAME (optional; uses default from URI if omitted)
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

function isMigrationFilename(name) {
  // Example: 20251226_1201_some_migration.mjs
  return /^\d{8}_\d{4}_.+\.mjs$/.test(name);
}

async function listMigrationFiles(dirAbs) {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n !== "run.mjs")
    .filter(isMigrationFilename)
    .sort((a, b) => a.localeCompare(b));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const dryRun = args.has("--dry-run");

  const migrationsDirAbs = path.resolve(process.cwd(), "db", "migration");
  const files = await listMigrationFiles(migrationsDirAbs);

  if (!files.length) {
    console.log("No migration files found.");
    return;
  }

  console.log(`Found ${files.length} migration file(s).` + (dryRun ? " (dry-run)" : ""));

  if (dryRun) {
    for (const f of files) console.log(`- ${f}`);
    return;
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

    const migrationsColl = db.collection("migrations");
    await migrationsColl.createIndex({ name: 1 }, { unique: true });

    const applied = new Set(
      (
        await migrationsColl
          .find({}, { projection: { name: 1 } })
          .toArray()
      )
        .map((d) => d?.name)
        .filter((n) => typeof n === "string"),
    );

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`- skip (already applied): ${file}`);
        continue;
      }

      const fullPath = path.join(migrationsDirAbs, file);
      const startedAt = Date.now();
      console.log(`- run: ${file}`);

      const mod = await import(fullPath);
      const up = mod?.up;
      if (typeof up !== "function") {
        throw new Error(`Migration ${file} must export async function up({ db, mongoose }).`);
      }

      await up({ db, mongoose });

      const durationMs = Date.now() - startedAt;
      await migrationsColl.insertOne({ name: file, appliedAt: new Date(), durationMs });
      console.log(`  done in ${durationMs}ms`);
    }

    console.log("All migrations complete.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});


