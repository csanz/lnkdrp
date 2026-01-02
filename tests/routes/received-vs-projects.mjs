/**
 * Route test: Request repos (Received) must be listed via `/api/requests` and never via `/api/projects`.
 *
 * Run:
 *   LNKDRP_TEST_COOKIE="..." npm run tests:routes -- --path tests/routes/received-vs-projects.mjs
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

  // 1) Create a request repo (requires authenticated user in this app).
  const name = `Route test request ${new Date().toISOString()}`;
  const createBody = {
    name,
    description: "Route test",
    reviewEnabled: false,
    reviewPrompt: "",
  };

  const created = await fetchJson(baseUrl, "/api/requests", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(createBody),
  });

  if (created.res.status === 401) {
    throw new Error(
      [
        "POST /api/requests returned 401 (auth required).",
        "Provide auth cookies via env var LNKDRP_TEST_COOKIE (copy from your browser request headers).",
      ].join(" "),
    );
  }

  assert(
    created.res.ok,
    `POST /api/requests failed (${created.res.status}). body=${created.text || ""}`,
  );

  const projectId = created.json?.request?.projectId ?? "";
  assert(typeof projectId === "string" && projectId, "Create response missing request.projectId");

  try {
    // 2) List received (requests).
    const reqList = await fetchJson(baseUrl, "/api/requests?limit=50&page=1", {
      method: "GET",
      headers: { ...headers },
    });
    assert(reqList.res.ok, `GET /api/requests failed (${reqList.res.status}). body=${reqList.text || ""}`);
    const requestItems = Array.isArray(reqList.json?.items) ? reqList.json.items : [];
    assert(
      requestItems.some((r) => r && typeof r === "object" && r.id === projectId),
      `Created request repo not found in /api/requests list. projectId=${projectId}`,
    );
    assert(
      requestItems.every((r) => !r || typeof r !== "object" || r.isRequest === true),
      "Expected every /api/requests item to have isRequest=true",
    );

    // 3) List projects (must exclude requests).
    const projList = await fetchJson(baseUrl, "/api/projects?limit=50&page=1", {
      method: "GET",
      headers: { ...headers },
    });
    assert(projList.res.ok, `GET /api/projects failed (${projList.res.status}). body=${projList.text || ""}`);
    const projects = Array.isArray(projList.json?.projects) ? projList.json.projects : [];
    assert(
      !projects.some((p) => p && typeof p === "object" && p.id === projectId),
      `Request repo leaked into /api/projects list. projectId=${projectId}`,
    );
    assert(
      projects.every((p) => !p || typeof p !== "object" || p.isRequest !== true),
      "Expected no /api/projects items to have isRequest=true",
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[received-vs-projects] context:", { baseUrl, headers: redactCookie(headers), projectId });
    throw e;
  } finally {
    // 4) Cleanup (best-effort): delete the created project by id.
    await fetchJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { ...headers },
    }).catch(() => {});
  }
}




