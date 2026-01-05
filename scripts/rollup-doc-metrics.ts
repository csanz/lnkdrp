/**
 * Roll up per-doc metrics into each Doc’s cached `metricsSnapshot`.
 *
 * This is designed to be run manually or on a schedule (cron) to keep owner doc pages fast.
 *
 * Usage:
 *   tsx scripts/rollup-doc-metrics.ts --once [--docId <id>] [--days <n>] [--limit <n>]
 *   tsx scripts/rollup-doc-metrics.ts [--interval <ms>]
 *
 * Env (loaded automatically from .env.local/.env):
 *   - MONGODB_URI (required)
 *   - MONGODB_DB_NAME (optional)
 */
import dotenv from "dotenv";
import path from "node:path";
import { rollupDocMetrics } from "../src/lib/metrics/rollupDocMetrics";
import { connectMongo } from "../src/lib/mongodb";
import { CronHealthModel } from "../src/lib/models/CronHealth";
import { runTaskWithErrorLogging } from "../src/lib/errors/runTaskWithErrorLogging";
import { ERROR_CODE_WORKER_TASK_FAILED } from "../src/lib/errors/logger";

// Load env the same way Next does for local dev scripts.
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Read a CLI value for `--<name>`.
 *
 * - Returns `null` when the flag is not present.
 * - Returns `""` when the flag is present but has no value (or next arg is another flag).
 */
function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return "";
  return next;
}

/**
 * True if the process args include the boolean flag `--<name>`.
 */
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Parse a positive integer (>= 1) from a string value.
 *
 * Returns null for missing/invalid/non-positive inputs.
 */
function asPositiveInt(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

/**
 * Run a single rollup pass and (best-effort) write a cron health snapshot.
 *
 * CLI params:
 * - `--docId`: optional single doc id to roll up
 * - `--days`: optional lookback window
 * - `--limit`: optional max number of docs to process
 */
async function runOnce() {
  const docId = arg("docId") || undefined;
  const days = asPositiveInt(arg("days")) ?? undefined;
  const limit = asPositiveInt(arg("limit")) ?? undefined;

  const startedAt = new Date();
  const params = {
    ...(docId ? { docId } : {}),
    ...(days ? { days } : {}),
    ...(limit ? { limit } : {}),
  };

  // Health snapshot: best-effort (should not block rollup).
  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey: "doc-metrics" },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: params,
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  let res: Awaited<ReturnType<typeof rollupDocMetrics>> | null = null;
  try {
    res = await rollupDocMetrics(params);
    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey: "doc-metrics" },
        {
          $set: {
            status: "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: { ok: res.ok, processed: res.processed, days: res.days },
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const message = err instanceof Error ? err.message : String(err);

    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey: "doc-metrics" },
        {
          $set: {
            status: "error",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastErrorAt: finishedAt,
            lastError: message,
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    throw err;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[rollup-doc-metrics] processed=${res?.processed ?? 0} days=${res?.days ?? ""} docIds=${res?.docIds
      ?.slice(0, 5)
      .join(",")}${res && res.docIds.length > 5 ? "…" : ""}`,
  );
}

/**
 * Script entry point.
 *
 * Modes:
 * - `--once`: run a single rollup pass
 * - default: run continuously every `--interval <ms>` (defaults to 10s)
 */
async function main() {
  if (hasFlag("once")) {
    await runTaskWithErrorLogging(
      { taskName: "rollup-doc-metrics:once", category: "worker", code: ERROR_CODE_WORKER_TASK_FAILED, meta: { jobKey: "doc-metrics" } },
      () => runOnce(),
    );
    return;
  }

  const intervalMs = asPositiveInt(arg("interval")) ? (asPositiveInt(arg("interval")) as number) : 10_000;
  // eslint-disable-next-line no-console
  console.log(`[rollup-doc-metrics] running every ${intervalMs}ms (Ctrl+C to stop)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    await runTaskWithErrorLogging(
      {
        taskName: "rollup-doc-metrics:loop",
        category: "worker",
        code: ERROR_CODE_WORKER_TASK_FAILED,
        meta: { jobKey: "doc-metrics", intervalMs },
      },
      () => runOnce(),
    );
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

void main();


