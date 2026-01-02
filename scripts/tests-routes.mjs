import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const out = { path: null, baseUrl: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    if (a === "--path") out.path = argv[i + 1] ?? null;
    if (a === "--baseUrl") out.baseUrl = argv[i + 1] ?? null;
  }
  return out;
}

function requireStringEnv(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function usage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage:",
      "  npm run tests:routes -- --path tests/routes/received-vs-projects.mjs",
      "  npm run tests:routes -- --path tests/routes/sidebar-snapshot.mjs",
      "",
      "Options:",
      "  --path <file>        Route-test module to run (required)",
      "  --baseUrl <url>      Base URL of running app (default: http://localhost:3001)",
      "  --help, -h           Show this help",
      "",
      "Optional env (runner -> request headers):",
      "  LNKDRP_BASE_URL=http://localhost:3001",
      "  LNKDRP_TEST_COOKIE='<cookie header value>'   (recommended for authenticated routes)",
      "  LNKDRP_TEMP_USER_ID='<id>'",
      "  LNKDRP_TEMP_USER_SECRET='<secret>'",
      "",
      "Dev-only auth bypass (set on the Next.js server process, not here):",
      "  API_TEST_BYPASS_AUTH=1",
      "  API_TEST_USER_ID='<mongo user _id>'",
    ].join("\n"),
  );
}

async function main() {
  const { path: relPath, baseUrl: baseArg, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    process.exit(0);
  }
  if (!relPath) {
    usage();
    process.exit(2);
  }

  const baseUrl = baseArg ?? requireStringEnv("LNKDRP_BASE_URL") ?? "http://localhost:3001";
  const cookie = requireStringEnv("LNKDRP_TEST_COOKIE");
  const tempId = requireStringEnv("LNKDRP_TEMP_USER_ID");
  const tempSecret = requireStringEnv("LNKDRP_TEMP_USER_SECRET");

  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (tempId) headers["x-temp-user-id"] = tempId;
  if (tempSecret) headers["x-temp-user-secret"] = tempSecret;

  const abs = path.isAbsolute(relPath) ? relPath : path.join(process.cwd(), relPath);
  const url = pathToFileURL(abs).toString();

  const mod = await import(url);
  const run = mod?.run ?? mod?.default;
  if (typeof run !== "function") {
    throw new Error(`Route test module must export a function as 'run' or default export: ${relPath}`);
  }

  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[tests:routes] baseUrl=${baseUrl} path=${relPath}`);
  const result = await run({ baseUrl, headers });
  if (result !== undefined) {
    try {
      // eslint-disable-next-line no-console
      console.log("[tests:routes] result:", JSON.stringify(result, null, 2));
    } catch {
      // eslint-disable-next-line no-console
      console.log("[tests:routes] result:", String(result));
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[tests:routes] OK (${Date.now() - startedAt}ms)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[tests:routes] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});


