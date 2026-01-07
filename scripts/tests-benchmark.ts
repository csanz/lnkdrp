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
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Args = {
  mode: "dashboard" | "document" | "leftmenu" | "admin" | null;
  baseUrl: string;
  cookie: string;
  iterations: number;
  timeoutMs: number;
  json: boolean;
  summary: boolean;
  select: boolean;
  selectSpec: string | null;
  docId: string | null;
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
  // Optional: parsed JSON for requests where we need to derive follow-up calls (e.g. billing cycleStart).
  jsonBody?: unknown;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run tests:benchmark -- --dashboard",
    "  npm run tests:benchmark -- --leftmenu",
    "",
    "Options:",
    "  --dashboard               Run dashboard benchmarks",
    "  --document                Run document (/doc/:docId) benchmarks",
    "  --leftmenu                Run left menu (sidebar) benchmarks",
    "  --admin                   (Listed for parity; not implemented)",
    "  --summary                 Print summary tables (default is section-by-section live output)",
    "  --select [spec]           Choose which sections/pages to run (interactive if omitted)",
    '                           Dashboard examples: --select 8   |  --select "1,8"  |  --select all',
    '                           Document examples:  --select 1   |  --select all',
    "  --doc-id <docId>          Document ObjectId to benchmark (document mode). If omitted, auto-picks most recent doc.",
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
  let summary = false;
  let select = false;
  let selectSpec: string | null = null;
  let docId: string | null = process.env.LNKDRP_DOC_ID?.trim() || null;

  const nextValue = (i: number) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dashboard") mode = "dashboard";
    else if (a === "--document") mode = "document";
    else if (a === "--leftmenu") mode = "leftmenu";
    else if (a === "--admin") mode = "admin";
    else if (a === "--summary") summary = true;
    else if (a === "--select") {
      select = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        selectSpec = next;
        i++;
      }
    } else if (typeof a === "string" && a.startsWith("--select=")) {
      select = true;
      const v = a.slice("--select=".length).trim();
      selectSpec = v || null;
    }
    else if (a === "--doc-id") docId = nextValue(i++);
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
  return { mode, baseUrl, cookie, iterations, timeoutMs, json, summary, select, selectSpec, docId };
}

function tryReadCookieFile(): string {
  try {
    const fp = path.join(process.cwd(), "scripts", "cookie.json");
    if (!fs.existsSync(fp)) return "";
    const raw = fs.readFileSync(fp, "utf8");
    const json = JSON.parse(raw) as any;
    const cookie = typeof json?.cookie === "string" ? json.cookie.trim() : "";
    return cookie;
  } catch {
    return "";
  }
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

async function timedFetchJson(opts: {
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
    const text = await res.text().catch(() => "");
    const bytes = text ? Buffer.byteLength(text, "utf8") : 0;
    let jsonBody: unknown = undefined;
    try {
      jsonBody = text ? JSON.parse(text) : undefined;
    } catch {
      jsonBody = undefined;
    }
    const t1 = performance.now();
    return {
      name: opts.name,
      method,
      url: opts.url,
      status: res.status,
      ok: res.ok,
      ms: t1 - t0,
      bytes,
      jsonBody,
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

function urlToRoute(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

function printTable(results: BenchResult[]) {
  const rows = results.map((r) => ({
    name: r.name,
    method: r.method,
    route: urlToRoute(r.url),
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
    console.log("  2) Document");
    // eslint-disable-next-line no-console
    console.log("  3) Left Menu");
    // eslint-disable-next-line no-console
    console.log("  4) Admin");
    const ans = (await rl.question("Enter 1-4: ")).trim();
    if (ans === "1") return "dashboard";
    if (ans === "2") return "document";
    if (ans === "3") return "leftmenu";
    if (ans === "4") return "admin";
    return null;
  } finally {
    rl.close();
  }
}

function printLeftMenuHeader(title: string) {
  // eslint-disable-next-line no-console
  console.log(`\nLeft Menu: ${title}`);
  // eslint-disable-next-line no-console
  console.log("-".repeat(`Left Menu: ${title}`.length));
}

function printBenchResultLine(r: BenchResult) {
  const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
  const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
  const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
  // eslint-disable-next-line no-console
  console.log(`${r.method} ${urlToRoute(r.url)} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
}

async function leftMenuBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];

  // This benchmarks the API calls made by the app's left sidebar:
  // - sidebar cache refresh (parallel): docs/projects/requests
  // - starred details resolution via /api/docs?ids=...
  // - paging modals (docs/projects/requests)
  // - delete doc modal (fetch doc to list folders/projects)
  for (let iter = 0; iter < args.iterations; iter++) {
    const iterLabel = args.iterations > 1 ? ` [${iter + 1}/${args.iterations}]` : "";

    printLeftMenuHeader(`Sidebar cache refresh (parallel)${iterLabel}`);
    const started = performance.now();
    const [docsRes, projectsRes, requestsRes] = await Promise.all([
      timedFetchJson({
        name: "leftmenu:docs:list(limit=5,page=1)",
        url: `${base}/api/docs?limit=5&page=1&sidebar=1`,
        method: "GET",
        headers,
        timeoutMs: args.timeoutMs,
      }),
      timedFetch({
        name: "leftmenu:projects:list(limit=10,page=1)",
        url: `${base}/api/projects?limit=10&page=1&sidebar=1`,
        method: "GET",
        headers,
        timeoutMs: args.timeoutMs,
      }),
      timedFetch({
        name: "leftmenu:requests:list(limit=10,page=1)",
        url: `${base}/api/requests?limit=10&page=1&sidebar=1`,
        method: "GET",
        headers,
        timeoutMs: args.timeoutMs,
      }),
    ]);
    const wallMs = performance.now() - started;

    [docsRes, projectsRes, requestsRes].forEach((r) => {
      results.push(r);
      printBenchResultLine(r);
    });

    // eslint-disable-next-line no-console
    console.log(`\nSidebar cache refresh total (wall clock): ${formatMs(wallMs)} (3 calls)`);

    // Starred metadata resolution (mirrors LeftSidebar's /api/docs?ids=... chunked call).
    // We simulate this by taking up to 3 recent docs from the sidebar docs list.
    printLeftMenuHeader(`Starred metadata (/api/docs?ids=...)${iterLabel}`);
    const docsJson = (docsRes as any).jsonBody as any;
    const docs = Array.isArray(docsJson?.docs) ? docsJson.docs : [];
    const ids = docs
      .map((d: any) => (typeof d?.id === "string" ? d.id.trim() : ""))
      .filter(Boolean)
      .slice(0, 3);

    const idsRes: BenchResult = ids.length
      ? await timedFetch({
          name: `leftmenu:docs:ids(count=${ids.length})`,
          url: `${base}/api/docs?ids=${encodeURIComponent(ids.join(","))}&sidebar=1`,
          method: "GET",
          headers,
          timeoutMs: args.timeoutMs,
        })
      : {
          name: "leftmenu:docs:ids(count=0)",
          method: "GET",
          url: `${base}/api/docs?ids=...`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: "Skipped (no doc ids available from /api/docs?limit=5)",
        };
    results.push(idsRes);
    printBenchResultLine(idsRes);

    // Modal opens (one request each).
    printLeftMenuHeader(`Docs modal${iterLabel}`);
    const docsModalRes = await timedFetch({
      name: "leftmenu:docs:modal(limit=20,page=1)",
      url: `${base}/api/docs?limit=20&page=1&sidebar=1`,
      method: "GET",
      headers,
      timeoutMs: args.timeoutMs,
    });
    results.push(docsModalRes);
    printBenchResultLine(docsModalRes);

    printLeftMenuHeader(`Projects modal${iterLabel}`);
    const projectsModalRes = await timedFetch({
      name: "leftmenu:projects:modal(limit=20,page=1)",
      url: `${base}/api/projects?limit=20&page=1&sidebar=1`,
      method: "GET",
      headers,
      timeoutMs: args.timeoutMs,
    });
    results.push(projectsModalRes);
    printBenchResultLine(projectsModalRes);

    printLeftMenuHeader(`Received modal${iterLabel}`);
    const receivedModalRes = await timedFetch({
      name: "leftmenu:requests:modal(limit=20,page=1)",
      url: `${base}/api/requests?limit=20&page=1&sidebar=1`,
      method: "GET",
      headers,
      timeoutMs: args.timeoutMs,
    });
    results.push(receivedModalRes);
    printBenchResultLine(receivedModalRes);

    // Delete doc modal: fetch doc details to show project memberships.
    printLeftMenuHeader(`Delete doc modal${iterLabel}`);
    const firstDocId = ids[0] ?? "";
    const deleteDocRes: BenchResult = firstDocId
      ? await timedFetch({
          name: "leftmenu:docs:get(for-delete-modal)",
          url: `${base}/api/docs/${encodeURIComponent(firstDocId)}`,
          method: "GET",
          headers,
          timeoutMs: args.timeoutMs,
        })
      : {
          name: "leftmenu:docs:get(for-delete-modal)",
          method: "GET",
          url: `${base}/api/docs/:docId`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: "Skipped (no doc ids available from /api/docs?limit=5)",
        };
    results.push(deleteDocRes);
    printBenchResultLine(deleteDocRes);
  }

  return results;
}

async function dashboardBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const commonHeaders: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  // Resolve org context (also validates auth). IMPORTANT: do not do hidden extra fetches.
  const orgsRes = await timedFetchJson({
    name: "orgs:list",
    url: `${base}/api/orgs`,
    method: "GET",
    headers: commonHeaders,
    timeoutMs: args.timeoutMs,
  });

  const orgsJson = (orgsRes as any).jsonBody as any;
  const activeOrgId = typeof orgsJson?.activeOrgId === "string" ? orgsJson.activeOrgId : "";
  const orgs = Array.isArray(orgsJson?.orgs) ? orgsJson.orgs : [];
  const match = orgs.find((o: any) => String(o?.id) === activeOrgId) ?? null;
  const activeOrg: { id: string; type: string; role: string } | null = match
    ? { id: String(match.id), type: String(match.type ?? ""), role: String(match.role ?? "") }
    : null;

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
    async () =>
      timedFetch({
        name: "orgs:active",
        url: `${base}/api/orgs/active`,
        method: "GET",
        headers: commonHeaders,
        timeoutMs: args.timeoutMs,
      }),
  ];

  // Billing usage depends on billing summary (cycleStart).
  requests.push(async () => {
    // Avoid hidden extra call: use the already-timed billing:summary response if present.
    const summaryRes = results.find((r) => r.name === "billing:summary" && !r.skipped) as BenchResult | undefined;
    const cycleStart = typeof (summaryRes as any)?.jsonBody?.cycle?.start === "string" ? String((summaryRes as any).jsonBody.cycle.start) : "";
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
      const r = await fn();
      results.push(r);
    }
  }
  return results;
}

type DashboardSection =
  | "Header"
  | "Overview"
  | "Account"
  | "Workspace"
  | "Teams"
  | "Usage"
  | "Limits"
  | "Billing & Invoices";

const ORDERED_SECTIONS: DashboardSection[] = [
  "Header",
  "Overview",
  "Account",
  "Workspace",
  "Teams",
  "Usage",
  "Limits",
  "Billing & Invoices",
];

type DocumentPage = "Main Page" | "Metrics Page" | "Share Page" | "History Page";

const ORDERED_DOC_PAGES: DocumentPage[] = ["Main Page", "Metrics Page", "Share Page", "History Page"];

function parseDashboardSelectSpec(spec: string): DashboardSection[] | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s === "all") return ORDERED_SECTIONS.slice();
  const raw = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const idxs = raw
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= ORDERED_SECTIONS.length);
  if (!idxs.length) return null;
  const unique = Array.from(new Set(idxs));
  return unique.map((n) => ORDERED_SECTIONS[n - 1]!).filter(Boolean) as DashboardSection[];
}

function parseDocumentSelectSpec(spec: string): DocumentPage[] | null {
  const s = spec.trim().toLowerCase();
  if (!s) return null;
  if (s === "all") return ORDERED_DOC_PAGES.slice();
  const raw = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const idxs = raw
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= ORDERED_DOC_PAGES.length);
  if (!idxs.length) return null;
  const unique = Array.from(new Set(idxs));
  return unique.map((n) => ORDERED_DOC_PAGES[n - 1]!).filter(Boolean) as DocumentPage[];
}

async function chooseDashboardSectionsInteractive(): Promise<DashboardSection[] | null> {
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("Select dashboard section(s) to benchmark (comma-separated):");
    ORDERED_SECTIONS.forEach((s, idx) => {
      // eslint-disable-next-line no-console
      console.log(`  ${idx + 1}) ${s}`);
    });
    // eslint-disable-next-line no-console
    console.log('  (or type "all")');
    const ans = (await rl.question("Selection: ")).trim().toLowerCase();
    if (!ans) return null;
    return parseDashboardSelectSpec(ans);
  } finally {
    rl.close();
  }
}

async function chooseDocumentPagesInteractive(): Promise<DocumentPage[] | null> {
  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("Select document page(s) to benchmark (comma-separated):");
    ORDERED_DOC_PAGES.forEach((s, idx) => {
      // eslint-disable-next-line no-console
      console.log(`  ${idx + 1}) ${s}`);
    });
    // eslint-disable-next-line no-console
    console.log('  (or type "all")');
    const ans = (await rl.question("Selection: ")).trim().toLowerCase();
    if (!ans) return null;
    return parseDocumentSelectSpec(ans);
  } finally {
    rl.close();
  }
}

type DashboardStep = {
  section: DashboardSection;
  name: string;
  method: "GET" | "POST";
  url: (ctx: { base: string; activeOrg: { id: string; type: string; role: string } | null }) => string;
  run: (ctx: { base: string; headers: Record<string, string>; activeOrg: { id: string; type: string; role: string } | null; timeoutMs: number; results: BenchResult[] }) => Promise<BenchResult>;
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${ms.toFixed(1)}ms`;
}

function printSectionHeader(title: DashboardSection) {
  // eslint-disable-next-line no-console
  console.log(`\n${title}`);
  // eslint-disable-next-line no-console
  console.log("-".repeat(title.length));
}

async function runWithSpinner(label: string, run: () => Promise<BenchResult>): Promise<BenchResult> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let idx = 0;
  const started = performance.now();
  const interval = setInterval(() => {
    const elapsed = performance.now() - started;
    const frame = frames[idx++ % frames.length];
    process.stdout.write(`\r${frame} ${label} (${formatMs(elapsed)})`);
  }, 80);

  try {
    const r = await run();
    return r;
  } finally {
    clearInterval(interval);
    process.stdout.write("\r");
    process.stdout.write(" ".repeat(Math.min(120, label.length + 32)));
    process.stdout.write("\r");
  }
}

async function runSectionParallel(opts: {
  section: DashboardSection;
  stepsForSection: DashboardStep[];
  ctxBase: { base: string; activeOrg: { id: string; type: string; role: string } | null };
  ctx: { base: string; headers: Record<string, string>; activeOrg: { id: string; type: string; role: string } | null; timeoutMs: number; results: BenchResult[] };
  iterations: number;
}): Promise<{ wallMs: number; results: BenchResult[] }> {
  const { section, stepsForSection, ctxBase, ctx, iterations } = opts;
  const started = performance.now();

  // Billing & Invoices has a real dependency chain in the UI:
  // - /api/billing/summary and /api/billing/invoices fire on mount
  // - /api/billing/usage waits on summary (needs cycleStart)
  // So treat it as: start (summary + invoices) in parallel, then run usage, then await invoices.
  if (section === "Billing & Invoices") {
    const summaryStep = stepsForSection.find((s) => s.name === "billing:summary") ?? null;
    const usageStep = stepsForSection.find((s) => s.name === "billing:usage(cycleStart=summary)") ?? null;
    const invoicesStep = stepsForSection.find((s) => s.name === "billing:invoices(default)") ?? null;

    if (summaryStep && usageStep && invoicesStep) {
      const results: BenchResult[] = [];
      for (let iter = 0; iter < iterations; iter++) {
        const invoicesPromise = invoicesStep.run(ctx);

        const summaryRes = await summaryStep.run(ctx);
        results.push(summaryRes);
        ctx.results.push(summaryRes);
        // eslint-disable-next-line no-console
        console.log(`GET ${urlToRoute(summaryStep.url(ctxBase))} -> ${summaryRes.skipped ? "SKIP" : summaryRes.status ?? "ERR"} (${summaryRes.ok ? "ok" : "fail"}) in ${formatMs(summaryRes.ms)}${summaryRes.error ? ` — ${summaryRes.error}` : ""}`);

        const usageRes = await usageStep.run(ctx);
        results.push(usageRes);
        ctx.results.push(usageRes);
        // eslint-disable-next-line no-console
        console.log(`GET ${urlToRoute(usageStep.url(ctxBase))} -> ${usageRes.skipped ? "SKIP" : usageRes.status ?? "ERR"} (${usageRes.ok ? "ok" : "fail"}) in ${formatMs(usageRes.ms)}${usageRes.error ? ` — ${usageRes.error}` : ""}`);

        const invoicesRes = await invoicesPromise;
        results.push(invoicesRes);
        ctx.results.push(invoicesRes);
        // eslint-disable-next-line no-console
        console.log(`GET ${urlToRoute(invoicesStep.url(ctxBase))} -> ${invoicesRes.skipped ? "SKIP" : invoicesRes.status ?? "ERR"} (${invoicesRes.ok ? "ok" : "fail"}) in ${formatMs(invoicesRes.ms)}${invoicesRes.error ? ` — ${invoicesRes.error}` : ""}`);
      }

      const wallMs = performance.now() - started;
      return { wallMs, results };
    }
  }

  type Task = { label: string; run: () => Promise<BenchResult> };
  const tasks: Task[] = [];
  for (const step of stepsForSection) {
    for (let iter = 0; iter < iterations; iter++) {
      const iterLabel = iterations > 1 ? ` [${iter + 1}/${iterations}]` : "";
      const route = urlToRoute(step.url(ctxBase));
      tasks.push({
        label: `${step.method} ${route}${iterLabel}`,
        run: () => step.run(ctx),
      });
    }
  }

  let done = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frameIdx = 0;
  const tick = setInterval(() => {
    const elapsed = performance.now() - started;
    const frame = frames[frameIdx++ % frames.length];
    process.stdout.write(`\r${frame} Loading ${section}… (${done}/${tasks.length}) ${formatMs(elapsed)}`);
  }, 80);

  const clearSpinnerLine = () => {
    process.stdout.write("\r");
    process.stdout.write(" ".repeat(120));
    process.stdout.write("\r");
  };

  const results: BenchResult[] = [];
  try {
    await Promise.all(
      tasks.map(async (t) => {
        const r = await t.run();
        results.push(r);
        ctx.results.push(r);
        done += 1;

        const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
        const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
        const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
        clearSpinnerLine();
        // eslint-disable-next-line no-console
        console.log(`${t.label} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
      }),
    );
  } finally {
    clearInterval(tick);
    clearSpinnerLine();
  }

  const wallMs = performance.now() - started;
  return { wallMs, results };
}

async function dashboardBenchBySection(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];

  const selected = args.select
    ? args.selectSpec
      ? parseDashboardSelectSpec(args.selectSpec)
      : process.stdin.isTTY
        ? await chooseDashboardSectionsInteractive()
        : null
    : ORDERED_SECTIONS.slice();
  if (!selected) return results;

  // Only fetch org list when a selected section actually needs active org resolution (Teams).
  // This keeps the Overview benchmark aligned with what you care about (no extra prerequisite call).
  let orgsRes: BenchResult | null = null;
  let activeOrg: { id: string; type: string; role: string } | null = null;
  if (selected.includes("Teams")) {
    orgsRes = await timedFetchJson({
      name: "orgs:list",
      url: `${base}/api/orgs`,
      method: "GET",
      headers,
      timeoutMs: args.timeoutMs,
    });
    results.push(orgsRes);
    const orgsJson = (orgsRes as any).jsonBody as any;
    const activeOrgId = typeof orgsJson?.activeOrgId === "string" ? orgsJson.activeOrgId : "";
    const orgs = Array.isArray(orgsJson?.orgs) ? orgsJson.orgs : [];
    const match = orgs.find((o: any) => String(o?.id) === activeOrgId) ?? null;
    activeOrg = match ? { id: String(match.id), type: String(match.type ?? ""), role: String(match.role ?? "") } : null;
  }

  const ctxBase = { base, activeOrg };
  const ctx = { base, headers, activeOrg, timeoutMs: args.timeoutMs, results };

  const steps: DashboardStep[] = [
    // Header (dashboard shell/top bar)
    // Fast-path goal: header should render without any required network calls.
    // (We defer org refresh, plan status, and credits fetch until interaction/idle.)

    // Overview
    {
      section: "Overview",
      name: "credits:snapshot",
      method: "GET",
      url: ({ base }) => `${base}/api/credits/snapshot`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "credits:snapshot", url: `${base}/api/credits/snapshot`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Overview",
      name: "dashboard:stats",
      method: "GET",
      url: ({ base }) => `${base}/api/dashboard/stats`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "dashboard:stats", url: `${base}/api/dashboard/stats`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Overview",
      name: "billing:status",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/status`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:status", url: `${base}/api/billing/status`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Overview",
      name: "billing:spend",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/spend`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:spend", url: `${base}/api/billing/spend`, method: "GET", headers, timeoutMs }),
    },

    // Account
    {
      section: "Account",
      name: "orgs:active:notification-preferences",
      method: "GET",
      url: ({ base }) => `${base}/api/orgs/active/notification-preferences`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({
          name: "orgs:active:notification-preferences",
          url: `${base}/api/orgs/active/notification-preferences`,
          method: "GET",
          headers,
          timeoutMs,
        }),
    },

    // Workspace
    {
      section: "Workspace",
      name: "orgs:active",
      method: "GET",
      url: ({ base }) => `${base}/api/orgs/active`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "orgs:active", url: `${base}/api/orgs/active`, method: "GET", headers, timeoutMs }),
    },

    // Teams
    {
      section: "Teams",
      name: "teams:members(activeOrg)",
      method: "GET",
      url: ({ base, activeOrg }) => `${base}/api/orgs/${encodeURIComponent(activeOrg?.id ?? ":orgId")}/members`,
      run: async ({ base, headers, timeoutMs, activeOrg }) => {
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
          headers,
          timeoutMs,
        });
      },
    },
    {
      section: "Teams",
      name: "teams:invites(activeOrg)",
      method: "GET",
      url: ({ base, activeOrg }) => `${base}/api/org-invites?orgId=${encodeURIComponent(activeOrg?.id ?? ":orgId")}`,
      run: async ({ base, headers, timeoutMs, activeOrg }) => {
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
          headers,
          timeoutMs,
        });
      },
    },

    // Usage
    {
      section: "Usage",
      name: "credits:snapshot",
      method: "GET",
      url: ({ base }) => `${base}/api/credits/snapshot`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "credits:snapshot", url: `${base}/api/credits/snapshot`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Usage",
      name: "billing:status",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/status`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:status", url: `${base}/api/billing/status`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Usage",
      name: "billing:spend",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/spend`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:spend", url: `${base}/api/billing/spend`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Usage",
      name: "dashboard:usage-daily(days=30)",
      method: "GET",
      url: ({ base }) => `${base}/api/dashboard/usage-daily?days=30`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({
          name: "dashboard:usage-daily(days=30)",
          url: `${base}/api/dashboard/usage-daily?days=30`,
          method: "GET",
          headers,
          timeoutMs,
        }),
    },
    {
      section: "Usage",
      name: "dashboard:usage(days=30)",
      method: "GET",
      url: ({ base }) => `${base}/api/dashboard/usage?days=30`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({
          name: "dashboard:usage(days=30)",
          url: `${base}/api/dashboard/usage?days=30`,
          method: "GET",
          headers,
          timeoutMs,
        }),
    },

    // Limits
    {
      section: "Limits",
      name: "billing:spend",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/spend`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:spend", url: `${base}/api/billing/spend`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Limits",
      name: "credits:quality-defaults",
      method: "GET",
      url: ({ base }) => `${base}/api/credits/quality-defaults`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({
          name: "credits:quality-defaults",
          url: `${base}/api/credits/quality-defaults`,
          method: "GET",
          headers,
          timeoutMs,
        }),
    },

    // Billing & Invoices
    {
      section: "Billing & Invoices",
      name: "billing:summary",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/summary`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetchJson({ name: "billing:summary", url: `${base}/api/billing/summary`, method: "GET", headers, timeoutMs }),
    },
    {
      section: "Billing & Invoices",
      name: "billing:usage(cycleStart=summary)",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/usage?cycleStart=...`,
      run: async ({ base, headers, timeoutMs, results }) => {
        const summaryRes = results.find((r) => r.name === "billing:summary" && !r.skipped) as BenchResult | undefined;
        const cycleStart = typeof (summaryRes as any)?.jsonBody?.cycle?.start === "string" ? String((summaryRes as any).jsonBody.cycle.start) : "";
        const cycleEnd = typeof (summaryRes as any)?.jsonBody?.cycle?.end === "string" ? String((summaryRes as any).jsonBody.cycle.end) : "";
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
        if (cycleEnd) qs.set("cycleEnd", cycleEnd);
        return timedFetch({
          name: "billing:usage(cycleStart=summary)",
          url: `${base}/api/billing/usage?${qs.toString()}`,
          method: "GET",
          headers,
          timeoutMs,
        });
      },
    },
    {
      section: "Billing & Invoices",
      name: "billing:invoices(default)",
      method: "GET",
      url: ({ base }) => `${base}/api/billing/invoices`,
      run: ({ base, headers, timeoutMs }) =>
        timedFetch({ name: "billing:invoices(default)", url: `${base}/api/billing/invoices`, method: "GET", headers, timeoutMs }),
    },
  ];

  for (const section of selected) {
    printSectionHeader(section);

    const stepsForSection = steps.filter((s) => s.section === section);

    // If we pre-fetched /api/orgs for Teams, print it as part of Teams output.
    if (section === "Teams" && orgsRes) {
      const route = urlToRoute(orgsRes.url);
      const statusLabel = orgsRes.skipped ? "SKIP" : orgsRes.status ?? "ERR";
      const okLabel = orgsRes.skipped ? "ok" : orgsRes.ok ? "ok" : "fail";
      const extra = orgsRes.error ? ` — ${orgsRes.error}` : "";
      // eslint-disable-next-line no-console
      console.log(`GET ${route} -> ${statusLabel} (${okLabel}) in ${formatMs(orgsRes.ms)}${extra}`);
    }

    // NOTE: Section totals represent "page load wall clock" (parallel), not sum of sequential calls.
    // This matches how the dashboard loads in the browser (requests fire concurrently).
    const { wallMs } = await runSectionParallel({
      section,
      stepsForSection,
      ctxBase,
      ctx,
      iterations: args.iterations,
    });

    // eslint-disable-next-line no-console
    console.log(`Section total (parallel page load): ${formatMs(wallMs)} (${stepsForSection.length * args.iterations} calls)`);
  }

  return results;
}

async function resolveDocIdForBench(args: Args): Promise<{ docId: string; setup?: BenchResult }> {
  if (args.docId && args.docId.trim()) return { docId: args.docId.trim() };
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };
  const setup = await timedFetchJson({
    name: "docs:list (setup)",
    url: `${base}/api/docs?limit=1&page=1`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  const body = (setup as any).jsonBody as any;
  const first = Array.isArray(body?.docs) && body.docs[0] ? body.docs[0] : null;
  const docId = typeof first?.id === "string" ? String(first.id).trim() : "";
  if (!docId) {
    throw new Error("Could not resolve a docId. Pass --doc-id <docId>.");
  }
  return { docId, setup };
}

async function documentMainBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];
  const resolved = await resolveDocIdForBench(args);
  if (resolved.setup) results.push(resolved.setup);

  const docId = resolved.docId;

  const printResult = (label: string, r: BenchResult) => {
    const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
    const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
    const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
    // eslint-disable-next-line no-console
    console.log(`${label} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
  };

  // 1) Core hydration/poll endpoint used by the page (fetchWithTempUser; cache: no-store).
  // Debug is opt-in on the client; benchmarks should measure the default fast path.
  const debugParam = "?lite=1";
  const docRes = await timedFetchJson({
    name: "docs:get",
    url: `${base}/api/docs/${encodeURIComponent(docId)}${debugParam}`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(docRes);
  printResult(`GET ${urlToRoute(docRes.url)}`, docRes);

  const docJson = (docRes as any).jsonBody as any;
  const doc = docJson?.doc ?? null;
  const blobUrl = typeof doc?.blobUrl === "string" ? doc.blobUrl.trim() : "";
  const currentUploadId = typeof doc?.currentUploadId === "string" ? doc.currentUploadId.trim() : "";
  const currentUploadVersion =
    typeof doc?.currentUploadVersion === "number" && Number.isFinite(doc.currentUploadVersion) ? doc.currentUploadVersion : null;
  const sharePasswordEnabled = Boolean(doc?.sharePasswordEnabled);
  const isReceivedViaRequest =
    Boolean(doc?.receivedViaRequestProjectId) || Boolean(doc?.project && typeof doc.project === "object" && (doc.project as any)?.isRequest);

  const pdfKey = currentUploadId || (currentUploadVersion != null ? String(currentUploadVersion) : "0");

  // 2) Remaining calls are largely independent; fire in parallel to mimic browser page load.
  const startedParallel = performance.now();
  const pending: Array<Promise<BenchResult>> = [];

  pending.push(
    timedFetch({
    name: "auth:session",
    url: `${base}/api/auth/session`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
    }),
  );

  pending.push(
    blobUrl
      ? timedFetch({
        name: "docs:pdf",
        url: `${base}/api/docs/${encodeURIComponent(docId)}/pdf?v=${encodeURIComponent(pdfKey)}`,
        method: "GET",
          // Mimic how PDF viewers typically load: they request a small Range first.
          // This keeps the benchmark aligned with "time to first render" rather than full download time.
          headers: { ...headers, range: "bytes=0-262143" },
        timeoutMs: args.timeoutMs,
      })
      : Promise.resolve({
        name: "docs:pdf",
        method: "GET",
        url: `${base}/api/docs/${encodeURIComponent(docId)}/pdf?v=${encodeURIComponent(pdfKey)}`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (doc blobUrl not ready)",
        } satisfies BenchResult),
  );

  pending.push(
    timedFetchJson({
    name: "projects:list(limit=50,page=1)",
      url: `${base}/api/projects?limit=50&page=1&lite=1`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
    }),
  );

  pending.push(
    sharePasswordEnabled
      ? timedFetchJson({
        name: "docs:share-password:get",
          url: `${base}/api/docs/${encodeURIComponent(docId)}/share-password?lite=1`,
        method: "GET",
        headers,
        timeoutMs: args.timeoutMs,
      })
      : Promise.resolve({
        name: "docs:share-password:get",
        method: "GET",
          url: `${base}/api/docs/${encodeURIComponent(docId)}/share-password?lite=1`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (sharePasswordEnabled is false)",
        } satisfies BenchResult),
  );

  pending.push(
    isReceivedViaRequest
      ? timedFetchJson({
        name: "docs:reviews(latest=1)",
        url: `${base}/api/docs/${encodeURIComponent(docId)}/reviews?latest=1`,
        method: "GET",
        headers,
        timeoutMs: args.timeoutMs,
      })
      : Promise.resolve({
        name: "docs:reviews(latest=1)",
        method: "GET",
        url: `${base}/api/docs/${encodeURIComponent(docId)}/reviews?latest=1`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (doc is not request-received)",
        } satisfies BenchResult),
  );

  pending.push(
    timedFetchJson({
      name: "docs:changes",
      url: `${base}/api/docs/${encodeURIComponent(docId)}/changes?lite=1&limit=10`,
      method: "GET",
      headers,
      timeoutMs: args.timeoutMs,
    }),
  );

  const more = await Promise.all(pending);
  const wallParallelMs = performance.now() - startedParallel;
  for (const r of more) {
    results.push(r);
    printResult(`GET ${urlToRoute(r.url)}`, r);
  }

  const nonSkipped = results.filter((r) => !r.skipped);
  const totalMs = nonSkipped.reduce((acc, r) => acc + (Number.isFinite(r.ms) ? r.ms : 0), 0);
  // eslint-disable-next-line no-console
  console.log(`\nMain Page total (wall clock after doc hydration): ${formatMs(wallParallelMs)}`);
  // eslint-disable-next-line no-console
  console.log(`Main Page total (sum of calls): ${formatMs(totalMs)} (${nonSkipped.length} calls)`);

  return results;
}

async function documentMetricsBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];
  const resolved = await resolveDocIdForBench(args);
  if (resolved.setup) results.push(resolved.setup);
  const docId = resolved.docId;

  const printResult = (label: string, r: BenchResult) => {
    const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
    const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
    const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
    // eslint-disable-next-line no-console
    console.log(`${label} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
  };

  const days = 15;
  const shareviewsRes = await timedFetchJson({
    name: `docs:shareviews(days=${days})`,
    url: `${base}/api/docs/${encodeURIComponent(docId)}/shareviews?days=${encodeURIComponent(String(days))}&lite=1`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(shareviewsRes);
  printResult(`GET ${urlToRoute(shareviewsRes.url)}`, shareviewsRes);

  const nonSkipped = results.filter((r) => !r.skipped);
  const totalMs = nonSkipped.reduce((acc, r) => acc + (Number.isFinite(r.ms) ? r.ms : 0), 0);
  // eslint-disable-next-line no-console
  console.log(`\nMetrics Page total (sum of calls): ${formatMs(totalMs)} (${nonSkipped.length} calls)`);
  return results;
}

async function documentHistoryBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];
  const resolved = await resolveDocIdForBench(args);
  if (resolved.setup) results.push(resolved.setup);
  const docId = resolved.docId;

  const printResult = (label: string, r: BenchResult) => {
    const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
    const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
    const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
    // eslint-disable-next-line no-console
    console.log(`${label} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
  };

  const defaultsRes = await timedFetchJson({
    name: "credits:quality-defaults",
    url: `${base}/api/credits/quality-defaults`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(defaultsRes);
  printResult(`GET ${urlToRoute(defaultsRes.url)}`, defaultsRes);

  const docRes = await timedFetchJson({
    name: "docs:get",
    url: `${base}/api/docs/${encodeURIComponent(docId)}?lite=1`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(docRes);
  printResult(`GET ${urlToRoute(docRes.url)}`, docRes);

  const changesRes = await timedFetchJson({
    name: "docs:changes",
    url: `${base}/api/docs/${encodeURIComponent(docId)}/changes?lite=1&limit=10`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(changesRes);
  printResult(`GET ${urlToRoute(changesRes.url)}`, changesRes);

  const nonSkipped = results.filter((r) => !r.skipped);
  const totalMs = nonSkipped.reduce((acc, r) => acc + (Number.isFinite(r.ms) ? r.ms : 0), 0);
  // eslint-disable-next-line no-console
  console.log(`\nHistory Page total (sum of calls): ${formatMs(totalMs)} (${nonSkipped.length} calls)`);
  return results;
}

async function documentShareBench(args: Args): Promise<BenchResult[]> {
  const base = args.baseUrl;
  const cookie = args.cookie;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-lnkdrp-benchmark": "1",
    ...(cookie ? { cookie } : null),
  };

  const results: BenchResult[] = [];
  const resolved = await resolveDocIdForBench(args);
  if (resolved.setup) results.push(resolved.setup);
  const docId = resolved.docId;

  const printResult = (label: string, r: BenchResult) => {
    const statusLabel = r.skipped ? "SKIP" : r.status ?? "ERR";
    const okLabel = r.skipped ? "ok" : r.ok ? "ok" : "fail";
    const extra = r.skipped ? (r.error ? ` — ${r.error}` : "") : r.error ? ` — ${r.error}` : "";
    // eslint-disable-next-line no-console
    console.log(`${label} -> ${statusLabel} (${okLabel}) in ${formatMs(r.ms)}${extra}`);
  };

  // Resolve shareId + whether blob is ready.
  const docRes = await timedFetchJson({
    name: "docs:get (setup)",
    url: `${base}/api/docs/${encodeURIComponent(docId)}?lite=1`,
    method: "GET",
    headers,
    timeoutMs: args.timeoutMs,
  });
  results.push(docRes);
  printResult(`GET ${urlToRoute(docRes.url)}`, docRes);

  const docJson = (docRes as any).jsonBody as any;
  const doc = docJson?.doc ?? null;
  const shareId = typeof doc?.shareId === "string" ? doc.shareId.trim() : "";
  const blobUrl = typeof doc?.blobUrl === "string" ? doc.blobUrl.trim() : "";
  const allowDownload = Boolean(doc?.shareAllowPdfDownload);
  const allowRevisionHistory = Boolean(doc?.shareAllowRevisionHistory);
  const sharePasswordEnabled = Boolean(doc?.sharePasswordEnabled);

  // The public share page itself is a server-rendered Next route.
  // Benchmark it as well since it performs DB reads (DocModel.findOne) and gating.
  const sharePageRes = shareId
    ? await timedFetch({
        name: "share:page",
        url: `${base}/s/${encodeURIComponent(shareId)}`,
        method: "GET",
        headers: { ...headers, accept: "text/html" },
        timeoutMs: args.timeoutMs,
      })
    : ({
        name: "share:page",
        method: "GET",
        url: `${base}/s/:shareId`,
        status: null,
        ok: true,
        ms: 0,
        bytes: null,
        skipped: true,
        error: "Skipped (doc has no shareId)",
      } satisfies BenchResult);
  results.push(sharePageRes);
  printResult(`GET ${urlToRoute(sharePageRes.url)}`, sharePageRes);

  // Mimic the browser viewer load: after the page loads, the client viewer makes several calls.
  // Run these in parallel to match real page load behavior.
  const startedParallel = performance.now();
  const pending: Array<Promise<BenchResult>> = [];

  const viewerEnabled = shareId && !sharePasswordEnabled;

  // Owner/receiver context stats (viewer header UI).
  pending.push(
    viewerEnabled
      ? timedFetchJson({
          name: "share:stats:get",
          url: `${base}/api/share/${encodeURIComponent(shareId)}/stats`,
          method: "GET",
          headers,
          timeoutMs: args.timeoutMs,
        })
      : Promise.resolve({
          name: "share:stats:get",
          method: "GET",
          url: shareId ? `${base}/api/share/${encodeURIComponent(shareId)}/stats` : `${base}/api/share/:shareId/stats`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId ? "Skipped (doc has no shareId)" : "Skipped (share is password gated)",
        } satisfies BenchResult),
  );

  // Public view tracking (mutating): PdfJsViewer POSTs once per (shareId, botId), and records initial page.
  // Note: This is a real write (it matches production behavior).
  pending.push(
    viewerEnabled
      ? timedFetchJson({
          name: "share:stats:post(view,page=1)",
          url: `${base}/api/share/${encodeURIComponent(shareId)}/stats`,
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ botId: "benchmark-bot", pageNumber: 1 }),
          timeoutMs: args.timeoutMs,
        })
      : Promise.resolve({
          name: "share:stats:post(view,page=1)",
          method: "POST",
          url: shareId ? `${base}/api/share/${encodeURIComponent(shareId)}/stats` : `${base}/api/share/:shareId/stats`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId ? "Skipped (doc has no shareId)" : "Skipped (share is password gated)",
        } satisfies BenchResult),
  );

  // Revision history (only enabled when the author allows it). The viewer fetches this when the history panel is opened.
  pending.push(
    viewerEnabled && allowRevisionHistory
      ? timedFetchJson({
          name: "share:changes",
          url: `${base}/s/${encodeURIComponent(shareId)}/changes`,
          method: "GET",
          headers,
          timeoutMs: args.timeoutMs,
        })
      : Promise.resolve({
          name: "share:changes",
          method: "GET",
          url: shareId ? `${base}/s/${encodeURIComponent(shareId)}/changes` : `${base}/s/:shareId/changes`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId
            ? "Skipped (doc has no shareId)"
            : sharePasswordEnabled
              ? "Skipped (share is password gated)"
              : "Skipped (shareAllowRevisionHistory is false)",
        } satisfies BenchResult),
  );

  // PDF bytes (viewer will make Range requests).
  pending.push(
    viewerEnabled && blobUrl
      ? timedFetch({
          name: "share:pdf(range=0-262143)",
          url: `${base}/s/${encodeURIComponent(shareId)}/pdf`,
          method: "GET",
          // Mimic how PDF viewers typically load: they request a small Range first.
          // This keeps the benchmark aligned with "time to first render" rather than full download time.
          headers: { ...headers, range: "bytes=0-262143" },
          timeoutMs: args.timeoutMs,
        })
      : Promise.resolve({
          name: "share:pdf(range=0-262143)",
          method: "GET",
          url: shareId ? `${base}/s/${encodeURIComponent(shareId)}/pdf` : `${base}/s/:shareId/pdf`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId
            ? "Skipped (doc has no shareId)"
            : sharePasswordEnabled
              ? "Skipped (share is password gated)"
              : "Skipped (doc blobUrl not ready)",
        } satisfies BenchResult),
  );

  // Download URL exists when allowed (not fetched on initial load; it's a button action).
  pending.push(
    viewerEnabled && blobUrl && allowDownload
      ? timedFetch({
          name: "share:pdf(download=1,range=0-262143)",
          url: `${base}/s/${encodeURIComponent(shareId)}/pdf?download=1`,
          method: "GET",
          headers: { ...headers, range: "bytes=0-262143" },
          timeoutMs: args.timeoutMs,
        })
      : Promise.resolve({
          name: "share:pdf(download=1,range=0-262143)",
          method: "GET",
          url: shareId ? `${base}/s/${encodeURIComponent(shareId)}/pdf?download=1` : `${base}/s/:shareId/pdf?download=1`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId
            ? "Skipped (doc has no shareId)"
            : !blobUrl
              ? "Skipped (doc blobUrl not ready)"
              : sharePasswordEnabled
                ? "Skipped (share is password gated)"
              : "Skipped (shareAllowPdfDownload is false)",
        } satisfies BenchResult),
  );

  // Password gate unlock is only relevant when password is enabled and the viewer submits a password.
  pending.push(
    shareId && sharePasswordEnabled
      ? Promise.resolve({
          name: "share:unlock(password)",
          method: "POST",
          url: `${base}/api/share/${encodeURIComponent(shareId)}/unlock`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: "Skipped (requires a password to submit)",
        } satisfies BenchResult)
      : Promise.resolve({
          name: "share:unlock(password)",
          method: "POST",
          url: shareId ? `${base}/api/share/${encodeURIComponent(shareId)}/unlock` : `${base}/api/share/:shareId/unlock`,
          status: null,
          ok: true,
          ms: 0,
          bytes: null,
          skipped: true,
          error: !shareId ? "Skipped (doc has no shareId)" : "Skipped (sharePasswordEnabled is false)",
        } satisfies BenchResult),
  );

  const more = await Promise.all(pending);
  const wallParallelMs = performance.now() - startedParallel;
  for (const r of more) {
    results.push(r);
    const method = (r.method || "GET").toUpperCase();
    printResult(`${method} ${urlToRoute(r.url)}`, r);
  }

  const nonSkipped = results.filter((r) => !r.skipped && !r.name.includes("(setup)"));
  const totalMs = nonSkipped.reduce((acc, r) => acc + (Number.isFinite(r.ms) ? r.ms : 0), 0);
  // eslint-disable-next-line no-console
  console.log(`\nShare Page total (wall clock after setup): ${formatMs(wallParallelMs)}`);
  // eslint-disable-next-line no-console
  console.log(`Share Page total (sum of calls): ${formatMs(totalMs)} (${nonSkipped.length} calls)`);
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

  if (args.mode !== "dashboard" && args.mode !== "document" && args.mode !== "leftmenu") {
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(2);
    return;
  }

  if (!args.cookie) {
    const fromFile = tryReadCookieFile();
    if (fromFile) args.cookie = fromFile;
  }

  if (!args.cookie) {
    // eslint-disable-next-line no-console
    console.error("Missing cookie. Provide --cookie, env LNKDRP_COOKIE, or set scripts/cookie.json.");
    // eslint-disable-next-line no-console
    console.error("");
    // eslint-disable-next-line no-console
    console.error(usage());
    process.exit(2);
    return;
  }

  let results: BenchResult[] = [];
  if (args.mode === "dashboard") {
    results = args.summary ? await dashboardBench(args) : await dashboardBenchBySection(args);
  } else if (args.mode === "document") {
    const pages = args.select
      ? args.selectSpec
        ? parseDocumentSelectSpec(args.selectSpec)
        : process.stdin.isTTY
          ? await chooseDocumentPagesInteractive()
          : null
      : ["Main Page"];
    if (!pages || !pages.length) {
      // eslint-disable-next-line no-console
      console.error("No document pages selected.");
      process.exit(2);
      return;
    }
    const all: BenchResult[] = [];
    for (const p of pages) {
      // eslint-disable-next-line no-console
      console.log(`\nDocument: ${p}`);
    // eslint-disable-next-line no-console
      console.log("-".repeat(`Document: ${p}`.length));
      if (p === "Main Page") all.push(...(await documentMainBench(args)));
      else if (p === "Metrics Page") all.push(...(await documentMetricsBench(args)));
      else if (p === "History Page") all.push(...(await documentHistoryBench(args)));
      else if (p === "Share Page") all.push(...(await documentShareBench(args)));
      else {
    // eslint-disable-next-line no-console
        console.error(`Not implemented: ${p}`);
      }
    }
    results = all;
  } else if (args.mode === "leftmenu") {
    results = await leftMenuBench(args);
  }

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ args: { ...args, cookie: args.cookie ? "<redacted>" : "" }, results }, null, 2));
    return;
  }

  if (args.summary) printTable(results);

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


