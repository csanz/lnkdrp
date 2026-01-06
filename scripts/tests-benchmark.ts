/**
 * Benchmark runner for timing key app requests.
 *
 * Usage:
 *   npm run tests:benchmark -- --dashboard
 *
 * Auth:
 *   Provide a full Cookie header (copied from a browser request) via:
 *     - --cookie "a=b; c=d"
 *     - or env LNKDRP_COOKIE="a=b; c=d"
 *
 * Notes:
 * - This script does NOT start the Next.js server. Run `npm run dev` separately.
 * - Default base URL matches repo dev port (3001).
 */
import { performance } from "node:perf_hooks";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Args = {
  mode: "dashboard" | "admin" | null;
  baseUrl: string;
  cookie: string;
  iterations: number;
  timeoutMs: number;
  json: boolean;
};

type BenchResult = {
  name: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  ms: number;
  bytes: number | null;
  error?: string;
  skipped?: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run tests:benchmark -- --dashboard",
    "",
    "Options:",
    "  --dashboard               Run dashboard benchmarks",
    "  --admin                   (Listed for parity; not implemented)",
    "  --base-url <url>          Base URL (default: http://localhost:3001)",
    "  --cookie <cookieHeader>   Full Cookie header value (or env LNKDRP_COOKIE)",
    "  --iterations <n>          Repeat each request n times (default: 1)",
    "  --timeout-ms <ms>         Per-request timeout (default: 30000)",
    "  --json                    Emit JSON results",
    "",
    "Cookie capture tip:",
    '  Open the app in a browser, open DevTools -> Network, click a /api/* request,',
    '  and copy the "Cookie" request header value.',
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let mode: Args["mode"] = null;
  let baseUrl = process.env.LNKDRP_BASE_URL?.trim() || "http://localhost:3001";
  let cookie = process.env.LNKDRP_COOKIE?.trim() || "";
  let iterations = 1;
  let timeoutMs = 30_000;
  let json = false;

  const nextValue = (i: number) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dashboard") mode = "dashboard";
    else if (a === "--admin") mode = "admin";
    else if (a === "--base-url") baseUrl = nextValue(i++);
    else if (a === "--cookie") cookie = nextValue(i++);
    else if (a === "--iterations") iterations = Math.max(1, Math.floor(Number(nextValue(i++))));
    else if (a === "--timeout-ms") timeoutMs = Math.max(1000, Math.floor(Number(nextValue(i++))));
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(usage());
      process.exit(0);
    } else if (a?.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }

  baseUrl = baseUrl.replace(/\/+$/, "");
  return { mode, baseUrl, cookie, iterations, timeoutMs, json };
}

function msStats(values: number[]) {
  const v = values.slice().sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((acc, x) => acc + x, 0);
  const p = (q: number) => v[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))] ?? 0;
  return {
    n,
    min: v[0] ?? 0,
    p50: p(0.5),
    p90: p(0.9),
    p99: p(0.99),
    max: v[n - 1] ?? 0,
    avg: n ? sum / n : 0,
  };
}

async function timedFetch(opts: {
  name: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<BenchResult> {
  const method = (opts.method || "GET").toUpperCase();
  const controller = new AbortController();
  const t0 = performance.now();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(opts.url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer().catch(() => null);
    const t1 = performance.now();
    return {
      name: opts.name,
      method,
      url: opts.url,
      status: res.status,
      ok: res.ok,
      ms: t1 - t0,
      bytes: buf ? buf.byteLength : null,
    };
  } catch (e) {
    const t1 = performance.now();
    return {
      name: opts.name,
      method,
      url: opts.url,
      status: null,
      ok: false,
      ms: t1 - t0,
      bytes: null,
      error: e instanceof Error ? e.message : "Request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function printTable(results: BenchResult[]) {
  const rows = results.map((r) => ({
    name: r.name,
    method: r.method,
    status: r.skipped ? "SKIP" : r.status ?? "ERR",
    ms: r.ms.toFixed(1),
    ok: r.skipped ? true : r.ok,
    bytes: r.bytes ?? "",
    error: r.error ?? "",
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
}

async function chooseModeInteractive(): Promise<Args["mode"]> {
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("Select benchmark target:");
    // eslint-disable-next-line no-console
    console.log("  1) Dashboard");
    // eslint-disable-next-line no-console
    console.log("  2) Admin");
    const ans = (await rl.question("Enter 1 or 2: ")).trim();
    if (ans === "1") return "dashboard";
    if (ans === "2") return "admin";
    return null;
  } finally {
    rl.close();
  }
}

async function dashboardBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const commonHeaders: Record<string, string> = {
    accept: "application/json",
    ...(cookie ? { cookie } : null),
  };

  // Resolve org context (also validates auth).
  const orgsRes = await timedFetch({
    name: "orgs:list",
    url: `${base}/api/orgs`,
    method: "GET",
    headers: commonHeaders,
    timeoutMs: args.timeoutMs,
  });

  let activeOrg: { id: string; type: string; role: string } | null = null;
  if (orgsRes.ok) {
    try {
      const res = await fetch(`${base}/api/orgs`, { method: "GET", headers: commonHeaders });
      const json = (await res.json().catch(() => null)) as any;
      const activeOrgId = typeof json?.activeOrgId === "string" ? json.activeOrgId : "";
      const orgs = Array.isArray(json?.orgs) ? json.orgs : [];
      const match = orgs.find((o: any) => String(o?.id) === activeOrgId) ?? null;
      if (match) {
        activeOrg = {
          id: String(match.id),
          type: String(match.type ?? ""),
          role: String(match.role ?? ""),
        };
      }
    } catch {
      // ignore; we still proceed with other requests
    }
  }

  // Define the dashboard requests (matching what the UI calls).
  const requests: Array<() => Promise<BenchResult>> = [
    async () => orgsRes,
    async () =>
      timedFetch({
        name: "credits:snapshot",
        url: `${base}/api/credits/snapshot`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "dashboard:stats",
        url: `${base}/api/dashboard/stats`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "billing:status",
        url: `${base}/api/billing/status`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "billing:spend",
        url: `${base}/api/billing/spend`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "dashboard:usage-daily(days=30)",
        url: `${base}/api/dashboard/usage-daily?days=30`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "dashboard:usage(days=30)",
        url: `${base}/api/dashboard/usage?days=30`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "credits:quality-defaults",
        url: `${base}/api/credits/quality-defaults`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "billing:summary",
        url: `${base}/api/billing/summary`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "billing:invoices(default)",
        url: `${base}/api/billing/invoices`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
    async () =>
      timedFetch({
        name: "orgs:active:notification-preferences",
        url: `${base}/api/orgs/active/notification-preferences`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
  ];

  // Billing usage depends on billing summary (cycleStart).
  requests.push(async () => {
    const res = await fetch(`${base}/api/billing/summary`, { method: "GET", headers: commonHeaders }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    const cycleStart = typeof (json as any)?.cycle?.start === "string" ? String((json as any).cycle.start) : "";
    if (!cycleStart) {
      return {
        name: "billing:usage(cycleStart=summary)",
        method: "GET",
        url: `${base}/api/billing/usage?cycleStart=...`,
        status: null,
        ok: false,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (could not resolve cycleStart from /api/billing/summary)",
      };
    }
    const qs = new URLSearchParams();
    qs.set("cycleStart", cycleStart);
    return timedFetch({
      name: "billing:usage(cycleStart=summary)",
      url: `${base}/api/billing/usage?${qs.toString()}`,
      method: "GET",
      headers: commonHeaders,
      timeoutMs: args.timeoutMs,
    });
  });

  // Teams tab requests (only meaningful for non-personal orgs).
  requests.push(async () => {
    const eligible = Boolean(activeOrg && activeOrg.type !== "personal");
    if (!eligible || !activeOrg) {
      return {
        name: "teams:members(activeOrg)",
        method: "GET",
        url: `${base}/api/orgs/:orgId/members`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (active org is personal or unknown)",
      };
    }
    return timedFetch({
      name: "teams:members(activeOrg)",
      url: `${base}/api/orgs/${encodeURIComponent(activeOrg.id)}/members`,
      method: "GET",
      headers: commonHeaders,
      timeoutMs: args.timeoutMs,
    });
  });

  requests.push(async () => {
    const eligible = Boolean(activeOrg && activeOrg.type !== "personal");
    if (!eligible || !activeOrg) {
      return {
        name: "teams:invites(activeOrg)",
        method: "GET",
        url: `${base}/api/org-invites?orgId=:orgId`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (active org is personal or unknown)",
      };
    }
    return timedFetch({
      name: "teams:invites(activeOrg)",
      url: `${base}/api/org-invites?orgId=${encodeURIComponent(activeOrg.id)}`,
      method: "GET",
      headers: commonHeaders,
      timeoutMs: args.timeoutMs,
    });
  });

  const results: BenchResult[] = [];
  for (const fn of requests) {
    for (let i = 0; i < args.iterations; i++) {
      results.push(await fn());
    }
  }
  return results;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : String(e));
    // eslint-disable-next-line no-console
    console.error("");
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(2);
    return;
  }

  if (!args.mode) {
    if (!process.stdin.isTTY) {
      // eslint-disable-next-line no-console
      console.error(usage());
      process.exit(2);
      return;
    }
    args.mode = await chooseModeInteractive();
  }

  if (args.mode === "admin") {
    // eslint-disable-next-line no-console
    console.error("Admin benchmarks are not implemented yet. Use --dashboard.");
    process.exit(2);
    return;
  }

  if (args.mode !== "dashboard") {
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(2);
    return;
  }

  if (!args.cookie) {
    // eslint-disable-next-line no-console
    console.error("Missing cookie. Provide --cookie or env LNKDRP_COOKIE.");
    // eslint-disable-next-line no-console
    console.error("");
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(2);
    return;
  }

  const results = await dashboardBench(args);

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ args: { ...args, cookie: args.cookie ? "<redacted>" : "" }, results }, null, 2));
    return;
  }

  printTable(results);

  // Summary by request name.
  const byName = new Map<string, number[]>();
  for (const r of results) {
    if (r.skipped) continue;
    const arr = byName.get(r.name) ?? [];
    arr.push(r.ms);
    byName.set(r.name, arr);
  }

  const summary = Array.from(byName.entries()).map(([name, times]) => {
    const s = msStats(times);
    return {
      name,
      n: s.n,
      min_ms: s.min.toFixed(1),
      p50_ms: s.p50.toFixed(1),
      p90_ms: s.p90.toFixed(1),
      p99_ms: s.p99.toFixed(1),
      max_ms: s.max.toFixed(1),
      avg_ms: s.avg.toFixed(1),
    };
  });

  // eslint-disable-next-line no-console
  console.log("\nSummary (ms):");
  // eslint-disable-next-line no-console
  console.table(summary);
}

void main();


