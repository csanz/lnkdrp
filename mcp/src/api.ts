/**
 * Typed client for the lnkdrp REST API, one instance per MCP session.
 *
 * Every call carries the caller's own `Authorization: Bearer lnk_…`, the `x-lnkdrp-agent`
 * attribution header (read lazily so it can change after `initialize`), JSON content types and a
 * 20s timeout. Non-2xx responses become `ToolError`s via `mapApiError`. The key is never logged.
 *
 * Envelopes verified against the route handlers on 2026-09-13:
 * - `GET  /api/agent/whoami`                   -> `{ ok, userId, email, orgId, orgName, isPersonalOrg, plan, keyPrefix, scopes, client }`
 * - `POST /api/docs` `{ title }`               -> 201 `{ doc: { id, shareId, title, status, shareEnabled, … }, planWarning? }`
 * - `GET  /api/docs?q=<shareId>`               -> `{ docs: [{ id, shareId, title, status, … }] }` (`q` matches title or shareId)
 * - `GET  /api/docs/:id?lite=1`                -> `{ doc: { id, shareId, title, status, shareEnabled, shareAllowPdfDownload,
 *                                                  shareAllowRevisionHistory, sharePasswordEnabled, previewImageUrl,
 *                                                  currentUploadId, aiOutput, isArchived, … } }`
 * - `PATCH /api/docs/:id`                      -> `{ doc: {…same…}, planWarning? }`; 402 `{ code: "plan_limit", … }`
 * - `DELETE /api/docs/:id`                     -> `{ ok: true }`
 * - `POST /api/docs/:id/share-password` `{ password }` (string sets, `null` removes) -> `{ sharePasswordEnabled }`
 * - `POST /api/uploads`                        -> 201 `{ upload: { id, docId, version, status } }`
 * - `POST /api/uploads/:id/import-url` `{ url }` -> `{ ok: true }`; 400 `{ error }`; 415 `{ error, code }`
 * - `POST /api/uploads/:id/process`            -> `{ ok: true, alreadyProcessing? }`; 409 `UPLOAD_NOT_READY`; 402 credits
 * - `GET  /api/docs/:id/shareviews?days&viewers=1` -> `{ ok, days, analyticsDaysLimit, analyticsTier, viewerCount, totals, series, viewers, anonymousViewers }`
 */
import { API_TIMEOUT_MS } from "./config";
import { mapApiError, ToolError } from "./errors";

export type Whoami = {
  ok: true;
  userId: string;
  email: string | null;
  orgId: string;
  orgName: string | null;
  isPersonalOrg: boolean;
  plan: string;
  keyPrefix: string;
  scopes: string[];
  client: string;
};

export type PlanWarning = { limit: string; used: number; max: number; grace: unknown };

export type DocStatus = "draft" | "preparing" | "ready" | "failed";

export type ApiDoc = {
  id: string;
  shareId: string | null;
  title: string | null;
  status: DocStatus | string;
  isArchived: boolean;
  currentUploadId: string | null;
  previewImageUrl: string | null;
  oneLiner: string | null;
  summary: string | null;
  shareEnabled: boolean;
  shareAllowPdfDownload: boolean;
  shareAllowRevisionHistory: boolean;
  sharePasswordEnabled: boolean;
};

export type ApiDocListItem = { id: string; shareId: string | null; title: string | null; status: string };

export type ApiUpload = { id: string; docId: string; version: number | null; status: string };

export type DocPatch = Partial<{
  title: string;
  shareEnabled: boolean;
  shareAllowPdfDownload: boolean;
  shareAllowRevisionHistory: boolean;
  isArchived: boolean;
}>;

export type ShareViewsTotals = {
  views: number;
  downloads: number;
  pagesViewed: number;
  timeSpentMs: number;
  authenticatedViewers: number;
  anonymousViewers: number;
};

export type ShareViewsViewer = {
  name: string | null;
  email: string | null;
  views: number;
  timeSpentMs: number;
  pagesViewed: number;
  pagesSeen: number[];
  firstSeen: string | null;
  lastSeen: string | null;
};

export type ShareViews = {
  days: number;
  analyticsDaysLimit: number | null;
  analyticsTier: "basic" | "deep" | string;
  viewerCount: number;
  totals: ShareViewsTotals;
  series: Array<{ date: string; views: number; downloads: number }>;
  viewers: ShareViewsViewer[];
  anonymousViewers: ShareViewsViewer[];
};

type Query = Record<string, string | number | boolean | undefined>;

/** Narrow to a plain object, else `{}`. */
function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A string value or null. */
function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number or `fallback`. */
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Normalise a doc from `GET/POST/PATCH /api/docs…` (`{ doc }` envelope already unwrapped). */
function asDoc(raw: unknown): ApiDoc {
  const d = rec(raw);
  const ai = rec(d.aiOutput);
  const id = strOrNull(d.id) ?? strOrNull(d._id);
  if (!id) throw new ToolError("upstream", "lnkdrp API returned a document without an id.");
  return {
    id,
    shareId: strOrNull(d.shareId),
    title: strOrNull(d.title),
    status: strOrNull(d.status) ?? "draft",
    isArchived: Boolean(d.isArchived),
    currentUploadId: strOrNull(d.currentUploadId),
    previewImageUrl: strOrNull(d.previewImageUrl),
    oneLiner: strOrNull(ai.one_liner),
    summary: strOrNull(ai.summary),
    shareEnabled: d.shareEnabled !== false,
    shareAllowPdfDownload: Boolean(d.shareAllowPdfDownload),
    shareAllowRevisionHistory: Boolean(d.shareAllowRevisionHistory),
    sharePasswordEnabled: Boolean(d.sharePasswordEnabled ?? d.sharePasswordHash),
  };
}

/** Normalise the optional `planWarning` returned by doc create/patch. */
function asPlanWarning(raw: unknown): PlanWarning | undefined {
  const w = rec(raw);
  if (typeof w.limit !== "string") return undefined;
  return { limit: w.limit, used: num(w.used), max: num(w.max), grace: w.grace ?? null };
}

/** Normalise one viewer row from the shareviews route (drops userId and per-page maps). */
function asViewer(raw: unknown): ShareViewsViewer {
  const v = rec(raw);
  return {
    name: strOrNull(v.name),
    email: strOrNull(v.email),
    views: num(v.views),
    timeSpentMs: num(v.timeSpentMs),
    pagesViewed: num(v.pagesViewed),
    pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen.filter((n): n is number => typeof n === "number") : [],
    firstSeen: strOrNull(v.firstSeen),
    lastSeen: strOrNull(v.lastSeen),
  };
}

export type ApiClientOptions = {
  baseUrl: string;
  key: string;
  /** Read per request so the attribution header can be updated once `initialize` names the client. */
  agent: () => string;
  timeoutMs?: number;
};

/** REST client bound to one API key and one agent identity. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly agent: () => string;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
    this.agent = opts.agent;
    this.timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  }

  /** Public share URL for a doc. */
  shareUrl(shareId: string): string {
    return `${this.baseUrl}/s/${encodeURIComponent(shareId)}`;
  }

  /** Low-level request; throws `ToolError` on non-2xx, timeout or network failure. */
  async request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: { body?: unknown; query?: Query } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          "x-lnkdrp-agent": this.agent(),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ToolError(
        "upstream",
        aborted
          ? `lnkdrp API ${method} ${path} timed out after ${Math.round(this.timeoutMs / 1000)}s.`
          : `Could not reach the lnkdrp API at ${this.baseUrl} (${method} ${path}).`,
        { details: { path, method, reason: aborted ? "timeout" : "network" } },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) throw mapApiError({ status: res.status, body, method, path, siteUrl: this.baseUrl });
    return body as T;
  }

  /** `GET /api/agent/whoami` — also what registers the connection on the key. */
  async whoami(): Promise<Whoami> {
    const w = rec(await this.request("GET", "/api/agent/whoami"));
    const userId = strOrNull(w.userId);
    const orgId = strOrNull(w.orgId);
    if (!userId || !orgId) throw new ToolError("upstream", "lnkdrp whoami returned no workspace.");
    return {
      ok: true,
      userId,
      email: strOrNull(w.email),
      orgId,
      orgName: strOrNull(w.orgName),
      isPersonalOrg: Boolean(w.isPersonalOrg),
      plan: strOrNull(w.plan) ?? "free",
      keyPrefix: strOrNull(w.keyPrefix) ?? "",
      scopes: Array.isArray(w.scopes) ? w.scopes.filter((s): s is string => typeof s === "string") : [],
      client: strOrNull(w.client) ?? "",
    };
  }

  async createDoc(input: { title: string }): Promise<{ doc: ApiDoc; planWarning?: PlanWarning }> {
    const body = rec(await this.request("POST", "/api/docs", { body: input }));
    return { doc: asDoc(body.doc), planWarning: asPlanWarning(body.planWarning) };
  }

  async getDoc(docId: string): Promise<ApiDoc> {
    const body = rec(await this.request("GET", `/api/docs/${encodeURIComponent(docId)}`, { query: { lite: 1 } }));
    return asDoc(body.doc);
  }

  /** List docs matching `q` (title or shareId, case-insensitive substring). Archived docs are excluded by the API. */
  async listDocs(input: { q: string; limit?: number }): Promise<ApiDocListItem[]> {
    const body = rec(await this.request("GET", "/api/docs", { query: { q: input.q, limit: input.limit ?? 50 } }));
    const docs = Array.isArray(body.docs) ? body.docs : [];
    return docs.map((raw) => {
      const d = rec(raw);
      return { id: strOrNull(d.id) ?? "", shareId: strOrNull(d.shareId), title: strOrNull(d.title), status: strOrNull(d.status) ?? "draft" };
    });
  }

  async patchDoc(docId: string, patch: DocPatch): Promise<{ doc: ApiDoc; planWarning?: PlanWarning }> {
    const body = rec(await this.request("PATCH", `/api/docs/${encodeURIComponent(docId)}`, { body: patch }));
    return { doc: asDoc(body.doc), planWarning: asPlanWarning(body.planWarning) };
  }

  async deleteDoc(docId: string): Promise<void> {
    await this.request("DELETE", `/api/docs/${encodeURIComponent(docId)}`);
  }

  /** Set (`string`) or remove (`null`) the share password. */
  async setSharePassword(docId: string, password: string | null): Promise<{ sharePasswordEnabled: boolean }> {
    const body = rec(await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/share-password`, { body: { password } }));
    return { sharePasswordEnabled: Boolean(body.sharePasswordEnabled) };
  }

  async createUpload(input: { docId: string; originalFileName: string }): Promise<ApiUpload> {
    const body = rec(
      await this.request("POST", "/api/uploads", {
        body: { docId: input.docId, originalFileName: input.originalFileName, contentType: "application/pdf", sizeBytes: 0 },
      }),
    );
    const u = rec(body.upload);
    const id = strOrNull(u.id);
    if (!id) throw new ToolError("upstream", "lnkdrp API returned an upload without an id.");
    return { id, docId: strOrNull(u.docId) ?? input.docId, version: typeof u.version === "number" ? u.version : null, status: strOrNull(u.status) ?? "uploading" };
  }

  async importUrl(uploadId: string, url: string): Promise<void> {
    await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/import-url`, { body: { url } });
  }

  async processUpload(uploadId: string): Promise<{ alreadyProcessing: boolean }> {
    const body = rec(await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/process`));
    return { alreadyProcessing: Boolean(body.alreadyProcessing) };
  }

  async shareViews(docId: string, input: { days: number; viewers: boolean }): Promise<ShareViews> {
    const body = rec(
      await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/shareviews`, {
        query: { days: input.days, viewers: input.viewers ? 1 : undefined },
      }),
    );
    const totals = rec(body.totals);
    const series = Array.isArray(body.series) ? body.series : [];
    return {
      days: num(body.days, input.days),
      analyticsDaysLimit: typeof body.analyticsDaysLimit === "number" ? body.analyticsDaysLimit : null,
      analyticsTier: strOrNull(body.analyticsTier) ?? "basic",
      viewerCount: num(body.viewerCount),
      totals: {
        views: num(totals.views),
        downloads: num(totals.downloads),
        pagesViewed: num(totals.pagesViewed),
        timeSpentMs: num(totals.timeSpentMs),
        authenticatedViewers: num(totals.authenticatedViewers),
        anonymousViewers: num(totals.anonymousViewers),
      },
      series: series.map((raw) => {
        const s = rec(raw);
        return { date: strOrNull(s.date) ?? "", views: num(s.views), downloads: num(s.downloads) };
      }),
      viewers: Array.isArray(body.viewers) ? body.viewers.map(asViewer) : [],
      anonymousViewers: Array.isArray(body.anonymousViewers) ? body.anonymousViewers.map(asViewer) : [],
    };
  }
}
