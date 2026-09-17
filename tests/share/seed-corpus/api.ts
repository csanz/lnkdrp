/**
 * Plumbing shared by the seed-corpus scripts: the email-safety guard, the manifest on disk, an
 * API-key client for the owner side, and the two public calls a reader makes (stats POST, PDF
 * download GET).
 *
 * Deliberately no helper for download requests, workspace invites, replacement uploads or cron
 * routes: each of those makes the running dev server send real email (see `assertSafePath`).
 */
import fs from "node:fs";
import path from "node:path";

export const APP_URL = (process.env.SEED_APP_URL ?? process.env.TRAFFIC_APP_URL ?? "http://localhost:3001").replace(/\/+$/, "");
export const SEED_AGENT = "lnkdrp-seed/1.0";

/** Exit 2 unless the process runs with `EMAIL_TRANSPORT=console`. First statement of every seed script. */
export function assertConsoleEmail(): void {
  if ((process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase() !== "console") {
    console.error("Refusing to run: set EMAIL_TRANSPORT=console (L19)");
    process.exit(2);
  }
}

export const SEED_DIR = path.resolve(__dirname, "..", ".seed");

export type ManifestLink = { shareId: string; label: string; isDefault: boolean; allowDownload: boolean };
export type ManifestDoc = { slug: string; docId: string; uploadId: string | null; pages: string[]; links: ManifestLink[] };
export type ManifestPerson = {
  n: number;
  botId: string;
  botIdHash: string;
  docId: string;
  shareId: string;
  archetype: string;
  live: boolean;
  batch: number | null;
  status: "sent" | "refused" | "planned";
  visits: Array<{ visitId: string; visitIdHash: string; startAt: string; endAt: string }>;
  download: string | null;
};
export type ManifestTraffic = {
  seed: number;
  runStart: string;
  fixupAt: string | null;
  refused: Array<{ docId: string; shareId: string; label: string; kind: "disabled" | "expired"; maxEnd: string; disableAt: string }>;
  refusedShareIds: string[];
  people: ManifestPerson[];
  ownerPreviews: ManifestPerson[];
  liveBatches: number[];
  skipped: string[];
};
export type Manifest = {
  tag: string;
  orgId: string;
  userId: string;
  apiKeyId: string | null;
  count: number;
  createdAt: string;
  docs: ManifestDoc[];
  abandonedDocIds: string[];
  traffic?: ManifestTraffic;
  cleanedAt?: string;
};

export function assertTag(tag: string | null): string {
  if (!tag || !/^sc[a-z0-9]{4,24}$/.test(tag)) throw new Error("--tag <sc + lowercase letters/digits> is required, e.g. --tag sc20260917ab12");
  return tag;
}

export function manifestPath(tag: string): string {
  return path.join(SEED_DIR, tag, "manifest.json");
}

export function readManifest(tag: string): Manifest | null {
  const file = manifestPath(tag);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Manifest) : null;
}

/** Write through a temp file so an interrupted run never leaves half a manifest. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export function writeManifest(m: Manifest): void {
  writeJsonAtomic(manifestPath(m.tag), m);
}

export function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

const FORBIDDEN_PATH = /download-requests|invite|\/api\/cron\//i;

/** Throw before any request to a path that can send email from the dev server. */
export function assertSafePath(path: string): void {
  if (FORBIDDEN_PATH.test(path)) throw new Error(`seed tooling never calls ${path} (email-sending path)`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function retryAfterMs(res: Response, attempt: number): number {
  const raw = Number(res.headers.get("retry-after"));
  const base = Number.isFinite(raw) && raw > 0 ? raw * 1000 : 1000 * 2 ** Math.min(attempt, 5);
  return base + Math.floor(Math.random() * 400);
}

export type ApiResult<T = Record<string, unknown>> = { status: number; body: T };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Owner-side client: `Authorization: Bearer lnk_…` plus the agent header, 429-aware. */
export class SeedApi {
  constructor(
    private readonly key: string,
    readonly baseUrl = APP_URL,
  ) {}

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { body?: unknown; timeoutMs?: number; okStatuses?: number[] } = {},
  ): Promise<ApiResult<T>> {
    assertSafePath(path);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.key}`,
            "x-lnkdrp-agent": SEED_AGENT,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt < 8) {
        await res.arrayBuffer().catch(() => undefined);
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { error: text.slice(0, 200) };
      }
      if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
        const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : text.slice(0, 200);
        throw new ApiError(`${method} ${path} -> ${res.status}: ${msg}`, res.status, body);
      }
      return { status: res.status, body: body as T };
    }
  }

  whoami() {
    return this.request<{ userId?: string; orgId?: string; plan?: string }>("GET", "/api/agent/whoami");
  }

  async createDoc(title: string): Promise<{ id: string; shareId: string | null }> {
    const { body } = await this.request<{ doc?: { id?: string; shareId?: string } }>("POST", "/api/docs", { body: { title } });
    const id = body.doc?.id;
    if (!id) throw new Error("POST /api/docs returned no doc id");
    return { id, shareId: body.doc?.shareId ?? null };
  }

  /** First upload of a doc only; the caller must prove the doc has no non-failed upload first. */
  async createFirstUpload(input: {
    docId: string;
    originalFileName: string;
    sizeBytes: number;
    summary: string;
    keyPoints: string[];
  }): Promise<string> {
    const { body } = await this.request<{ upload?: { id?: string } }>("POST", "/api/uploads", {
      body: { ...input, contentType: "application/pdf" },
    });
    const id = body.upload?.id;
    if (!id) throw new Error("POST /api/uploads returned no upload id");
    return id;
  }

  async importBytes(uploadId: string, contentBase64: string, fileName: string): Promise<void> {
    await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/import-bytes`, { body: { contentBase64, fileName } });
  }

  /** POST process, backing off 1, 2, 4, 8, 16s while the server answers 409 UPLOAD_NOT_READY. */
  async processUpload(uploadId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request("POST", `/api/uploads/${encodeURIComponent(uploadId)}/process`, { okStatuses: [409] });
      if (res.status !== 409) return;
      if (attempt >= 5) throw new ApiError(`process ${uploadId}: still not ready`, 409, res.body);
      await sleep(1000 * 2 ** attempt);
    }
  }

  async docStatus(docId: string): Promise<string> {
    const { body } = await this.request<{ doc?: { status?: string } }>("GET", `/api/docs/${encodeURIComponent(docId)}?lite=1`);
    return body.doc?.status ?? "unknown";
  }

  /** Poll every 3s until the doc is ready or failed. */
  async waitForDoc(docId: string, timeoutMs = 180_000): Promise<"ready" | "failed" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.docStatus(docId);
      if (status === "ready" || status === "failed") return status;
      if (Date.now() > deadline) return "timeout";
      await sleep(3000);
    }
  }

  async listLinks(docId: string): Promise<Array<{ id: string; shareId: string; label: string; isDefault: boolean; allowDownload: boolean }>> {
    const { body } = await this.request<{ links?: Array<Record<string, unknown>> }>(
      "GET",
      `/api/docs/${encodeURIComponent(docId)}/links?limit=100`,
    );
    return (body.links ?? []).map((l) => ({
      id: String(l.id ?? ""),
      shareId: String(l.shareId ?? ""),
      label: String(l.label ?? ""),
      isDefault: Boolean(l.isDefault),
      allowDownload: Boolean(l.allowDownload),
    }));
  }

  async createLink(docId: string, link: { label: string; audience: string; allowDownload: boolean }): Promise<void> {
    await this.request("POST", `/api/docs/${encodeURIComponent(docId)}/links`, { body: link });
  }
}

/** Poll until the app answers at all (a dev server restart takes 30-60s). */
export async function waitForServer(baseUrl = APP_URL, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(3000);
  }
}

export type PublicCallOpts = { ip: string; cookie?: string | null; baseUrl?: string };

function publicHeaders(opts: PublicCallOpts, json: boolean): Record<string, string> {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-forwarded-for": opts.ip,
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  };
}

/** The viewer's stats POST. Returns the HTTP status (404 = the link refuses views); retries 429 and network errors. */
export async function postStats(path: string, body: Record<string, unknown>, opts: PublicCallOpts): Promise<number> {
  assertSafePath(path);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl ?? APP_URL}${path}`, {
        method: "POST",
        headers: publicHeaders(opts, true),
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= 20) throw err;
      await sleep(3000);
      continue;
    }
    await res.arrayBuffer().catch(() => undefined);
    if ((res.status === 429 || res.status >= 502) && attempt < 20) {
      await sleep(res.status === 429 ? retryAfterMs(res, attempt) : 3000);
      continue;
    }
    return res.status;
  }
}

/** `GET /s/:shareId/pdf?download=1&botId=` — a plain download on an allowDownload link; never the request flow. */
export async function getDownload(path: string, opts: PublicCallOpts): Promise<number> {
  assertSafePath(path);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl ?? APP_URL}${path}`, { headers: publicHeaders(opts, false), redirect: "manual" });
    } catch (err) {
      if (attempt >= 10) throw err;
      await sleep(3000);
      continue;
    }
    await res.arrayBuffer().catch(() => undefined);
    if ((res.status === 429 || res.status >= 502) && attempt < 10) {
      await sleep(res.status === 429 ? retryAfterMs(res, attempt) : 3000);
      continue;
    }
    return res.status;
  }
}
