import mongoose from "mongoose";
import { debugError, debugLog } from "@/lib/debug";

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  var mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = globalThis.mongooseCache ?? {
  conn: null,
  promise: null,
};

globalThis.mongooseCache = cache;

export async function connectMongoose(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    // IMPORTANT: don't throw at module import time; throw only when called,
    // so routes can return a clean JSON error instead of crashing compilation.
    const err = new Error(
      'Missing env var: MONGODB_URI (e.g. "mongodb://..." or "mongodb+srv://...")',
    );
    debugError(1, "[mongo] missing MONGODB_URI");
    throw err;
  }

  if (!cache.promise) {
    const started = Date.now();
    debugLog(1, "[mongo] connecting...", {
      dbName: process.env.MONGODB_DB_NAME ?? "(default)",
    });

    cache.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: process.env.MONGODB_DB_NAME,
        // Fail fast in dev so the UI doesn't sit "Saving…" for ~30s.
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 5_000,
      })
      .catch((err) => {
        // Allow retries after a failed attempt.
        cache.promise = null;
        debugError(1, "[mongo] connect failed", {
          ms: Date.now() - started,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
  }

  cache.conn = await cache.promise;
  debugLog(1, "[mongo] connected");
  return cache.conn;
}

