import mongoose from "mongoose";
import { AsyncLocalStorage } from "node:async_hooks";
import { debugEnabled, debugLog } from "@/lib/debug";

type MongoRequestStats = {
  path: string;
  ops: number;
  mongoMs: number;
  startedAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __lnkdrpMongoReqLoggerInstalled: boolean | undefined;
  // eslint-disable-next-line no-var
  var __lnkdrpMongoReqInflight:
    | Map<number, { store: MongoRequestStats; startedAt: number }>
    | undefined;
  // eslint-disable-next-line no-var
  var __lnkdrpMongoReqLogs:
    | Array<{ path: string; ops: number; mongoMs: number; totalMs: number; at: number }>
    | undefined;
}

const als = new AsyncLocalStorage<MongoRequestStats>();

function mongoReqLoggingEnabled(): boolean {
  // Dev-only: keep logging off in production no matter what.
  if (process.env.NODE_ENV === "production") return false;
  // Also require a higher debug level so we don't spam dev output by default.
  return debugEnabled(2);
}

function attachMongoCommandHooksOnce() {
  if (globalThis.__lnkdrpMongoReqLoggerInstalled) return;
  globalThis.__lnkdrpMongoReqLoggerInstalled = true;

  globalThis.__lnkdrpMongoReqInflight = globalThis.__lnkdrpMongoReqInflight ?? new Map();
  const inflight = globalThis.__lnkdrpMongoReqInflight;

  const attach = () => {
    try {
      const client = mongoose.connection.getClient() as any;
      if (!client || client.__lnkdrpMongoCommandHooksAttached) return;
      client.__lnkdrpMongoCommandHooksAttached = true;

      client.on("commandStarted", (ev: any) => {
        const store = als.getStore();
        if (!store) return;
        store.ops += 1;
        inflight.set(ev.requestId, { store, startedAt: Date.now() });
      });

      const finish = (ev: any) => {
        const entry = inflight.get(ev.requestId);
        if (!entry) return;
        inflight.delete(ev.requestId);
        entry.store.mongoMs += Date.now() - entry.startedAt;
      };

      client.on("commandSucceeded", finish);
      client.on("commandFailed", finish);
    } catch {
      // ignore: best-effort dev logging only
    }
  };

  // Attach immediately if connected, otherwise attach when the connection comes up.
  if (mongoose.connection.readyState === 1) attach();
  else mongoose.connection.on("connected", attach);
}

/**
 * Dev-only request-scoped Mongo op logging.
 *
 * Logs one line per request with:
 * - request path
 * - number of MongoDB commands executed
 * - total time spent in MongoDB commands (best-effort)
 *
 * Notes:
 * - This measures driver commands, which can be a superset of "Mongoose calls"
 *   (e.g., an aggregation cursor may emit `getMore`).
 * - Enabled only when `DEBUG_LEVEL>=2` and `NODE_ENV!=="production"`.
 */
export async function withMongoRequestLogging<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<T> {
  if (!mongoReqLoggingEnabled()) return fn();
  attachMongoCommandHooksOnce();

  const path = new URL(request.url).pathname;
  const store: MongoRequestStats = { path, ops: 0, mongoMs: 0, startedAt: Date.now() };

  return als.run(store, async () => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const s = als.getStore();
      if (!s) return;
      const entry = {
        path: s.path,
        ops: s.ops,
        mongoMs: Math.round(s.mongoMs),
        totalMs: Date.now() - started,
        at: Date.now(),
      };
      globalThis.__lnkdrpMongoReqLogs = globalThis.__lnkdrpMongoReqLogs ?? [];
      globalThis.__lnkdrpMongoReqLogs.push(entry);
      if (globalThis.__lnkdrpMongoReqLogs.length > 50) globalThis.__lnkdrpMongoReqLogs.shift();
      debugLog(1, "[mongo:req]", entry);
    }
  });
}

/** Test helper: read the most recent mongo request log entry (only populated when logging is enabled). */
export function __getLastMongoRequestLog() {
  const logs = globalThis.__lnkdrpMongoReqLogs ?? [];
  return logs.length ? logs[logs.length - 1] : null;
}


