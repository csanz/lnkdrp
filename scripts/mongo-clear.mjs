#!/usr/bin/env node
/**
 * Danger: wipe ALL MongoDB collections in the configured database.
 *
 * Usage:
 *   npm run mongo:clear -- --all
 *
 * Env (loaded automatically from .env.local):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional; uses default from URI if omitted)
 */
import process from "node:process";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config({ path: ".env.local" });

function usage(exitCode = 1) {
  const msg = `
Usage:
  npm run mongo:clear -- --all

Notes:
  - This script loads .env.local automatically.
  - It refuses to run unless you pass --all.
  - It drops every non-system collection in the configured database.
`;
  console.error(msg.trim());
  process.exit(exitCode);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) usage(0);

  const shouldClearAll = args.has("--all");
  if (!shouldClearAll) {
    console.error('Refusing to run: pass "--all" to wipe ALL collections.');
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



