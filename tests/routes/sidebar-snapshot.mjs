/**
 * Route test: mimic the real sidebar cache refresh calls and assert correct separation.
 *
 * The app populates the left nav via `refreshSidebarCache()` which calls:
 * - GET /api/docs?limit=5&page=1
 * - GET /api/projects?limit=10&page=1
 * - GET /api/requests?limit=10&page=1
 *
 * Run:
 *   LNKDRP_TEST_COOKIE="..." npm run tests:routes -- --path tests/routes/sidebar-snapshot.mjs
 */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function fetchJson(baseUrl, urlPath, opts = {}) {
  const res = await fetch(new URL(urlPath, baseUrl), opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

function redactCookie(headers) {
  if (!headers) return headers;
  const h = { ...headers };
  if (h.cookie) h.cookie = "[redacted]";
  return h;
}

export async function run(ctx) {
  const baseUrl = ctx?.baseUrl ?? "http://localhost:3001";
  const headers = ctx?.headers ?? {};

  // 1) Create a request repo (auth required).
  const name = `Route test request ${new Date().toISOString()}`;
  const created = await fetchJson(baseUrl, "/api/requests", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name, description: "Sidebar snapshot test", reviewEnabled: false, reviewPrompt: "" }),
  });

  if (created.res.status === 401) {
    throw new Error(
      [
        "POST /api/requests returned 401 (auth required).",
        "Provide auth cookies via env var LNKDRP_TEST_COOKIE (copy from your browser request headers).",
      ].join(" "),
    );
  }
  assert(created.res.ok, `POST /api/requests failed (${created.res.status}). body=${created.text || ""}`);

  const projectId = created.json?.request?.projectId ?? "";
  assert(typeof projectId === "string" && projectId, "Create response missing request.projectId");

  let summary = {
    created: { projectId, name },
    sidebar: {
      docsCount: 0,
      projectsCount: 0,
      requestsCount: 0,
      inRequests: false,
      inProjects: false,
      requestsSample: [],
      projectsSample: [],
    },
  };

  try {
    // 2) Mimic sidebar refresh calls exactly.
    const [docsRes, projectsRes, requestsRes] = await Promise.all([
      fetchJson(baseUrl, "/api/docs?limit=5&page=1", { method: "GET", headers: { ...headers } }),
      fetchJson(baseUrl, "/api/projects?limit=10&page=1", { method: "GET", headers: { ...headers } }),
      fetchJson(baseUrl, "/api/requests?limit=10&page=1", { method: "GET", headers: { ...headers } }),
    ]);

    assert(docsRes.res.ok, `GET /api/docs failed (${docsRes.res.status}). body=${docsRes.text || ""}`);
    assert(
      Array.isArray(docsRes.json?.docs),
      "Expected /api/docs response to include { docs: [] }",
    );

    assert(projectsRes.res.ok, `GET /api/projects failed (${projectsRes.res.status}). body=${projectsRes.text || ""}`);
    const projects = Array.isArray(projectsRes.json?.projects) ? projectsRes.json.projects : [];

    assert(requestsRes.res.ok, `GET /api/requests failed (${requestsRes.res.status}). body=${requestsRes.text || ""}`);
    const requests = Array.isArray(requestsRes.json?.items) ? requestsRes.json.items : [];

    summary.sidebar.docsCount = Array.isArray(docsRes.json?.docs) ? docsRes.json.docs.length : 0;
    summary.sidebar.projectsCount = projects.length;
    summary.sidebar.requestsCount = requests.length;
    summary.sidebar.inRequests = requests.some((r) => r && typeof r === "object" && r.id === projectId);
    summary.sidebar.inProjects = projects.some((p) => p && typeof p === "object" && p.id === projectId);
    summary.sidebar.requestsSample = requests.slice(0, 10).map((r) => ({
      id: r?.id ?? null,
      name: r?.name ?? null,
      isRequest: r?.isRequest ?? null,
    }));
    summary.sidebar.projectsSample = projects.slice(0, 10).map((p) => ({
      id: p?.id ?? null,
      name: p?.name ?? null,
      isRequest: p?.isRequest ?? null,
    }));

    // 3) Core invariants (what the left nav needs).
    assert(
      summary.sidebar.inRequests,
      `Created request repo not found in /api/requests items. projectId=${projectId}`,
    );
    assert(
      !summary.sidebar.inProjects,
      `Request repo leaked into /api/projects projects. projectId=${projectId}`,
    );

    // 4) Shape expectations.
    assert(
      requests.every((r) => !r || typeof r !== "object" || r.isRequest === true),
      "Expected every /api/requests item to have isRequest=true",
    );
    assert(
      projects.every((p) => !p || typeof p !== "object" || p.isRequest !== true),
      "Expected no /api/projects items to have isRequest=true",
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[sidebar-snapshot] context:", { baseUrl, headers: redactCookie(headers), projectId });
    throw e;
  } finally {
    // Cleanup (best-effort).
    await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { ...headers },
    }).catch(() => {});
  }

  return summary;
}


