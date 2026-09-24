/**
 * Shared runner for `scripts/cron/cron.<job>.ts`.
 *
 * Every cron job in lnkdrp is an HTTP route under `src/app/api/cron/<job>` (see `vercel.json` for
 * the production schedule). These scripts invoke that same route with the cron secret, so one
 * code path serves Vercel Cron, a manual run, and a system crontab on a VM if the app ever moves
 * off Vercel. They never re-implement job logic.
 *
 * Env: `CRON_SECRET` (or legacy `LNKDRP_CRON_SECRET`); `CRON_TARGET_URL` = base URL of the app
 * to hit (default `NEXT_PUBLIC_SITE_URL`, then `http://localhost:3001`).
 * Flags: `--dry-run` (adds `?dryRun=1` for routes that support it), `--limit=N`,
 * `--target=https://…` (overrides CRON_TARGET_URL), `--post` (POST instead of GET; both work).
 */
import { exit } from "../lib/exit";

export async function runCronJob(job: string): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const opt = (name: string) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const secret = (process.env.CRON_SECRET || process.env.LNKDRP_CRON_SECRET || "").trim();
  const base = (opt("target") || process.env.CRON_TARGET_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001").replace(/\/+$/, "");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
  if (!secret && !local) {
    console.error(`[cron.${job}] CRON_SECRET is not set (required for ${base})`);
    process.exit(2);
  }
  if (!secret) console.warn(`[cron.${job}] no CRON_SECRET; a local dev server accepts unauthenticated cron calls outside production`);
  const url = new URL(`${base}/api/cron/${job}`);
  if (flag("dry-run")) url.searchParams.set("dryRun", "1");
  const limit = opt("limit");
  if (limit) url.searchParams.set("limit", limit);

  const started = Date.now();
  console.log(`[cron.${job}] ${flag("post") ? "POST" : "GET"} ${url.toString()}`);
  const res = await fetch(url, { method: flag("post") ? "POST" : "GET", headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body; print as is
  }
  console.log(`[cron.${job}] ${res.status} in ${Date.now() - started}ms`);
  console.log(typeof body === "string" ? body.slice(0, 2000) : JSON.stringify(body, null, 2).slice(0, 4000));
  await exit(res.ok ? 0 : 1);
}
