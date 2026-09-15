/**
 * Typed client for the lnkdrp REST API, one instance per MCP session.
 *
 * Every call carries the caller's own `Authorization: Bearer lnk_…`, the `x-lnkdrp-agent`
 * attribution header (read lazily so it can change after `initialize`), JSON content types and a
 * 20s timeout. Non-2xx responses become `ToolError`s via `mapApiError`. The key is never logged.
 *
 * Envelopes verified against the route handlers on 2026-09-13:
 * - `GET  /api/agent/whoami`                   -> `{ ok, userId, email, orgId, orgName, isPersonalOrg, plan, keyPrefix, scopes, client }`
 * - `POST /api/docs` `{ title }`               -> 201 `{ doc: { id, shareId, title, status, shareEnabled, … }, planWarning? }`; 402 `{ code: "plan_limit", … }` at the Free link cap
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
 * - `POST /api/uploads` also takes `{ summary?, keyPoints? }` (both or neither) -> agent summary, 0 credits; 400 `{ error, code: "invalid_summary" }`
 * - `GET  /api/uploads/:id`                    -> `{ upload: { id, docId, status, version, ai: UploadAi | null }, doc: { id, status } }`
 * - `GET  /api/credits/snapshot?fast=1`        -> `{ creditsRemaining, blocked, includedThisCycle, cycleEnd, … }` (session or key actor)
 * - `GET  /api/plan`                           -> `{ plan: "free"|"pro", limits, usage, … }`
 * - `GET  /api/docs/:id/shareviews?days&viewers=1&shareId=` -> `{ ok, days, analyticsDaysLimit, analyticsTier, viewerCount, totals, series, viewers, anonymousViewers }` (`shareId` scopes every number to one link)
 * - `GET  /api/docs/:id/links`                 -> `{ links: ShareLinkDTO[] }` (default link first)
 * - `POST /api/docs/:id/links` `{ label, … }`  -> 201 `{ link, planWarning? }` (always enabled — links are never plan-capped; `planWarning` only flags nearness to the shared-document cap)
 * - `PATCH /api/docs/:id/links/:linkId`        -> `{ link, planWarning? }`
 * - `DELETE /api/docs/:id/links/:linkId`       -> 204 (soft archive; analytics kept)
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

/** One share link of a document (`ShareLinkDTO` from `src/lib/share/links.ts`). */
export type ApiShareLink = {
  id: string;
  docId: string;
  shareId: string;
  label: string;
  audience: string | null;
  isDefault: boolean;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  passwordEnabled: boolean;
  expiresAt: string | null;
  active: boolean;
  status: "active" | "disabled" | "expired" | "archived" | string;
  createdVia: string;
  createdAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
};

/** Settings accepted when creating or updating a share link. */
export type ShareLinkPatch = Partial<{
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  expiresAt: string | null;
  password: string | null;
}>;

export type ApiUpload = { id: string; docId: string; version: number | null; status: string };

/** `upload.ai` from `GET /api/uploads/:id`: what the automatic AI steps did and why. */
export type UploadAi = {
  summary: "done" | "skipped" | "failed" | string;
  compare: "done" | "skipped" | "failed" | "not_applicable" | string;
  reason: string | null;
  code: "out_of_credits" | "daily_cap" | "plan" | "recipient" | "error" | string | null;
  creditsNeeded: number | null;
  creditsUsed: number;
  source: "owner" | "recipient" | string;
  summaryBy: { kind: string; client: string } | null;
};

/** The fields of `GET /api/credits/snapshot` the MCP server uses. `resetAt` is the first reset-like date found. */
export type CreditsSnapshotLite = {
  creditsRemaining: number | null;
  blocked: boolean;
  includedThisCycle: number | null;
  cycleEnd: string | null;
  resetAt: string | null;
};

export type DocPatch = Partial<{
  title: string;
  shareEnabled: boolean;
  shareAllowPdfDownload: boolean;
  shareAllowRevisionHistory: boolean;
  isArchived: boolean;
}>;

export type ShareViewsTotals = {
  views: number;
  /**
   * Owner-side opens that were recorded and excluded from every other figure. `views: 0,
   * ownerPreviews: 3` is "only the owner has opened this", not "nobody has". A floor: the flag
   * needs a signed-in session, so a logged-out owner counts as a recipient.
   */
  ownerPreviews: number;
  /** Tab sessions in the window. Counts events, where `views` counts recipients. */
  opens: number;
  /** `opens` is missing rows for traffic older than per-session tracking: a floor, not a count. */
  opensPartial: boolean;
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
  /** Milliseconds on each page, keyed by page number ("1", "2", …). Deep tier only. */
  pageTimeMsByPage: Record<string, number>;
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

/** Normalise `upload.ai`; null while processing has not finished. */
function asUploadAi(raw: unknown): UploadAi | null {
  if (!raw || typeof raw !== "object") return null;
  const a = rec(raw);
  const by = rec(a.summaryBy);
  return {
    summary: strOrNull(a.summary) ?? "done",
    compare: strOrNull(a.compare) ?? "not_applicable",
    reason: strOrNull(a.reason),
    code: strOrNull(a.code),
    creditsNeeded: typeof a.creditsNeeded === "number" ? a.creditsNeeded : null,
    creditsUsed: num(a.creditsUsed),
    source: strOrNull(a.source) ?? "owner",
    summaryBy: typeof by.client === "string" ? { kind: strOrNull(by.kind) ?? "agent", client: by.client } : null,
  };
}

/** Normalise the optional `planWarning` returned by doc create/patch. */
function asPlanWarning(raw: unknown): PlanWarning | undefined {
  const w = rec(raw);
  if (typeof w.limit !== "string") return undefined;
  return { limit: w.limit, used: num(w.used), max: num(w.max), grace: w.grace ?? null };
}

/** Normalise one share link from `/api/docs/:id/links` (`{ link }` / `{ links }` already unwrapped). */
function asShareLink(raw: unknown): ApiShareLink {
  const l = rec(raw);
  const id = strOrNull(l.id);
  const shareId = strOrNull(l.shareId);
  if (!id || !shareId) throw new ToolError("upstream", "lnkdrp API returned a share link without an id.");
  return {
    id,
    docId: strOrNull(l.docId) ?? "",
    shareId,
    label: strOrNull(l.label) ?? "",
    audience: strOrNull(l.audience),
    isDefault: Boolean(l.isDefault),
    enabled: Boolean(l.enabled),
    allowDownload: Boolean(l.allowDownload),
    allowRevisionHistory: Boolean(l.allowRevisionHistory),
    passwordEnabled: Boolean(l.passwordEnabled),
    expiresAt: strOrNull(l.expiresAt),
    active: Boolean(l.active),
    status: strOrNull(l.status) ?? "active",
    createdVia: strOrNull(l.createdVia) ?? "api",
    createdAt: strOrNull(l.createdAt),
    lastViewedAt: strOrNull(l.lastViewedAt),
    viewCount: num(l.viewCount),
    downloadCount: num(l.downloadCount),
  };
}

/** Normalise one viewer row from the shareviews route (drops userId and per-page maps). */
/** `{ "3": 8146 }` — a page-number-keyed map of milliseconds, with anything unusable dropped. */
function pageTimeMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const page = Number(k);
    if (!Number.isFinite(page) || page < 1) continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[String(Math.floor(page))] = Math.floor(v);
  }
  return out;
}

function asViewer(raw: unknown): ShareViewsViewer {
  const v = rec(raw);
  return {
    name: strOrNull(v.name),
    email: strOrNull(v.email),
    views: num(v.views),
    timeSpentMs: num(v.timeSpentMs),
    pagesViewed: num(v.pagesViewed),
    pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen.filter((n): n is number => typeof n === "number") : [],
    pageTimeMsByPage: pageTimeMap(v.pageTimeMsByPage),
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

  /** `GET /api/docs/:id/links` — every link of a document, default first. */
  async listShareLinks(docId: string): Promise<ApiShareLink[]> {
    const body = rec(await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/links`));
    return Array.isArray(body.links) ? body.links.map(asShareLink) : [];
  }

  /**
   * `POST /api/docs/:id/links` — create a link. Links are never plan-capped: the link always comes
   * back enabled (201). `planWarning` is only a heads-up that the workspace is near its separate
   * cap on shared *documents*. It used to say the link was "created disabled at the cap" — the
   * wording of the bug 1ce4413 removed, kept out of here so nobody wires it back in.
   */
  async createShareLink(docId: string, settings: ShareLinkPatch & { label: string }): Promise<{ link: ApiShareLink; planWarning?: PlanWarning }> {
    const body = rec(await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/links`, { body: settings }));
    return { link: asShareLink(body.link), planWarning: asPlanWarning(body.planWarning) };
  }

  /** `PATCH /api/docs/:id/links/:linkId` — change one link's settings. */
  async updateShareLink(docId: string, linkId: string, patch: ShareLinkPatch): Promise<{ link: ApiShareLink; planWarning?: PlanWarning }> {
    const body = rec(
      await this.request("PATCH", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}`, { body: patch }),
    );
    return { link: asShareLink(body.link), planWarning: asPlanWarning(body.planWarning) };
  }

  /** `DELETE /api/docs/:id/links/:linkId` — soft-archive a link (204; analytics are kept). */
  async deleteShareLink(docId: string, linkId: string): Promise<void> {
    await this.request("DELETE", `/api/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(linkId)}`);
  }

  async createUpload(input: { docId: string; originalFileName: string; summary?: string | undefined; keyPoints?: string[] | undefined }): Promise<ApiUpload> {
    const body = rec(
      await this.request("POST", "/api/uploads", {
        body: {
          docId: input.docId,
          originalFileName: input.originalFileName,
          contentType: "application/pdf",
          sizeBytes: 0,
          // Agent-written summary: both or neither (the server skips the paid AI summary when present).
          ...(input.summary !== undefined && input.keyPoints !== undefined ? { summary: input.summary, keyPoints: input.keyPoints } : {}),
        },
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

  /** `GET /api/uploads/:id` — upload status plus the AI outcome (`ai` is null until processing finishes). */
  async getUpload(uploadId: string): Promise<{ id: string; status: string | null; ai: UploadAi | null }> {
    const body = rec(await this.request("GET", `/api/uploads/${encodeURIComponent(uploadId)}`));
    const u = rec(body.upload);
    return { id: strOrNull(u.id) ?? uploadId, status: strOrNull(u.status), ai: asUploadAi(u.ai) };
  }

  /** `GET /api/credits/snapshot?fast=1` — credits left in the workspace (read defensively). */
  async creditsSnapshot(): Promise<CreditsSnapshotLite> {
    const s = rec(await this.request("GET", "/api/credits/snapshot", { query: { fast: 1 } }));
    const resetAt = strOrNull(s.resetAt) ?? strOrNull(s.creditsResetAt) ?? strOrNull(s.resetsAt) ?? strOrNull(s.nextResetAt) ?? strOrNull(s.cycleEnd);
    return {
      creditsRemaining: typeof s.creditsRemaining === "number" ? s.creditsRemaining : null,
      blocked: Boolean(s.blocked),
      includedThisCycle: typeof s.includedThisCycle === "number" ? s.includedThisCycle : null,
      cycleEnd: strOrNull(s.cycleEnd),
      resetAt,
    };
  }

  /** `GET /api/plan` — the workspace plan ("free" | "pro"). */
  async planSnapshot(): Promise<{ plan: string | null }> {
    const p = rec(await this.request("GET", "/api/plan"));
    return { plan: strOrNull(p.plan) };
  }

  /** Analytics for a document, or for one of its links when `shareId` is given. */
  async shareViews(docId: string, input: { days: number; viewers: boolean; shareId?: string | undefined }): Promise<ShareViews> {
    const body = rec(
      await this.request("GET", `/api/docs/${encodeURIComponent(docId)}/shareviews`, {
        query: { days: input.days, viewers: input.viewers ? 1 : undefined, shareId: input.shareId },
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
        ownerPreviews: num(totals.ownerPreviews),
        opens: num(totals.opens),
        opensPartial: totals.opensPartial === true,
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
