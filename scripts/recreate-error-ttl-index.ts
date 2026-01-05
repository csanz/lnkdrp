/**
 * Recreate the ErrorEvent TTL index (`createdAt`) with a new expireAfterSeconds.
 *
 * Why:
 * - TTL indexes in MongoDB are created with a specific `expireAfterSeconds`.
 * - Changing retention requires dropping + recreating the TTL index.
 *
 * Usage:
 *   tsx scripts/recreate-error-ttl-index.ts
 *
 * Env (loaded from .env.local/.env like other scripts):
 * - MONGODB_URI (required)
 * - MONGODB_DB_NAME (optional)
 * - ERROR_LOGGING_TTL_DAYS (optional; default 14)
 */
import dotenv from "dotenv";
import path from "node:path";
import { connectMongo } from "../src/lib/mongodb";
import { ErrorEventModel } from "../src/lib/models/ErrorEvent";

// Load env the same way Next does for local dev scripts.
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function parsePositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

async function main() {
  const ttlDays = parsePositiveInt(process.env.ERROR_LOGGING_TTL_DAYS) ?? 14;
  const expireAfterSeconds = Math.max(60, ttlDays * 24 * 60 * 60);

  await connectMongo();

  const coll = ErrorEventModel.collection;
  const indexes = await coll.listIndexes().toArray();

  // Drop any existing TTL index on createdAt (regardless of name).
  for (const idx of indexes) {
    const key = (idx as any)?.key;
    const isCreatedAtIndex = key && typeof key === "object" && key.createdAt === 1 && Object.keys(key).length === 1;
    const hasTtl = typeof (idx as any)?.expireAfterSeconds === "number";
    if (isCreatedAtIndex && hasTtl && typeof (idx as any)?.name === "string") {
      // eslint-disable-next-line no-console
      console.log(`[recreate-error-ttl-index] dropping index: ${(idx as any).name}`);
      // eslint-disable-next-line no-await-in-loop
      await coll.dropIndex((idx as any).name);
    }
  }

  // Create the TTL index with a stable name so it's easy to find next time.
  const name = "createdAt_ttl";
  // eslint-disable-next-line no-console
  console.log(`[recreate-error-ttl-index] creating TTL index (${ttlDays} days => ${expireAfterSeconds}s)`);
  await coll.createIndex({ createdAt: 1 }, { expireAfterSeconds, name });

  // eslint-disable-next-line no-console
  console.log("[recreate-error-ttl-index] done");
}

void main();


