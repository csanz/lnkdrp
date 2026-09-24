import mongoose from "mongoose";
import { judgeMongoAccess, mongoUriDatabase, type MongoAuthInfo } from "@/lib/db/access";
import { debugError, debugLog } from "@/lib/debug";

/**
 * Shared Mongoose connection helper.
 *
 * Uses a global cache (`globalThis.mongooseCache`) so that in serverless/dev hot-reload
 * scenarios we don't open duplicate connections.
 */

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

/**
 * Connect to MongoDB via Mongoose (cached).
 *
 * Throws when `MONGODB_URI` is missing. Safe to call multiple times.
 */
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
        // Enable driver command monitoring only when verbose debugging is on.
        // (This is used by dev-only request instrumentation; keep it off in production.)
        monitorCommands: process.env.NODE_ENV !== "production" && Number(process.env.DEBUG_LEVEL ?? 0) >= 2,
        // Fail fast so the UI doesn't sit "Saving…" for ~30s.
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 5_000,
        // Serverless-friendly pool: small, and release idle sockets quickly so
        // many concurrent lambdas don't exhaust Atlas connection limits.
        maxPoolSize: 10,
        minPoolSize: 0,
        maxIdleTimeMS: 30_000,
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
  void warnIfDatabaseNotGranted(cache.conn, MONGODB_URI);
  return cache.conn;
}

let accessChecked = false;

/**
 * Say so, once, when the connected user has no rights on the database this process will use.
 *
 * Authentication is cluster-wide, so a URI whose path names a database the user's role does not
 * cover connects without complaint and then fails every query with code 13. The first symptom is
 * a sign-in that bounces to `/api/auth/error` with a raw `find` command in the URL. One
 * `connectionStatus` call after connect names the mismatch instead (`src/lib/db/access.ts`).
 *
 * A warning, not a throw: the judgement reads the server's privilege list, and a role shape this
 * code has not seen must not take down a deployment that works. Logged with `console.error`
 * rather than the gated debug logger because a misconfiguration is worth a line at any level.
 */
async function warnIfDatabaseNotGranted(conn: typeof mongoose, uri: string) {
  if (accessChecked) return;
  accessChecked = true;
  try {
    const database = process.env.MONGODB_DB_NAME || mongoUriDatabase(uri) || conn.connection.db?.databaseName || "";
    const status = (await conn.connection.db?.admin().command({ connectionStatus: 1, showPrivileges: true })) as
      | { authInfo?: MongoAuthInfo }
      | undefined;
    const verdict = judgeMongoAccess(database, status?.authInfo);
    if (!verdict.ok) console.error(`[mongo] ${verdict.message}`);
  } catch (err) {
    // A server that refuses connectionStatus is not itself a problem; the next query says more.
    debugLog(2, "[mongo] access check skipped", err instanceof Error ? err.message : String(err));
  }
}

