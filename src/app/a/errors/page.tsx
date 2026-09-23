/**
 * Admin route: `/a/errors`
 *
 * Every 5xx the app returns writes an `ErrorEvent` row (`src/lib/http/errorResponse.ts` via
 * `logErrorEvent`), sanitized and TTL-retained. The query API over them has been complete for a
 * while — environment, severity, category, code, request id and fingerprint, with cursor
 * pagination — and there was no screen: `docs/FEATURES.md` listed "System → Error events" beside
 * siblings that all name a page path, with this one's silently missing, and DEPLOY.md stated the
 * gap flatly. The only way to read production errors on launch day was to hand-type the API URL.
 *
 * Two things shape the page. First, **the recurring error is the one worth seeing**: a stack that
 * fires four hundred times is one bug, and a list sorted purely by time buries the other nine
 * behind it. The top band groups the loaded rows by `fingerprint` and shows the heaviest, each one
 * a filter you can click into.
 *
 * Second, that grouping is **over what is loaded, not over the collection**. The API paginates and
 * does not aggregate, so a count here means "in the rows on this page". Saying so in the copy is
 * the difference between a useful hint and a number an admin will quote at somebody. Narrow with
 * the filters, or load more, and the grouping follows.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AdminAccessState,
  AdminAlert,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSection,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  DetailPanel,
  DetailRow,
  IdCell,
  JsonBlock,
  StatTile,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import Button from "@/components/ui/Button";
import { ADMIN_DASH, type AdminTone } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type ErrorRow = {
  id: string;
  createdAt: string | null;
  env: string | null;
  severity: string | null;
  category: string | null;
  code: string | null;
  message: string | null;
  stack: string | null;
  route: string | null;
  method: string | null;
  statusCode: number | null;
  requestId: string | null;
  workspaceId: string | null;
  userId: string | null;
  uploadId: string | null;
  docId: string | null;
  runId: string | null;
  model: string | null;
  fingerprint: string | null;
  meta: unknown;
  lastSeenAt: string | null;
};

type ErrorsResponse = { ok: boolean; items: ErrorRow[]; nextCursor: string | null };

const DESCRIPTION = "Every 5xx the app returned, sanitized and kept until the TTL drops it.";

/** The categories the API accepts; anything else it ignores. */
const CATEGORIES = ["api", "worker", "cron", "stripe", "db", "auth", "ai", "credits", "unknown"] as const;

const SEVERITY_TONE: Record<string, AdminTone> = { error: "danger", warn: "warning", info: "info" };

/**
 * What the search box means.
 *
 * The API has no free-text search — it filters on exact `code`, `requestId` and `fingerprint` —
 * so one box that guessed wrong would silently return nothing. The shape of the value says which
 * field it is: a request id is a uuid, a fingerprint is a hex digest, and anything else is a code.
 */
function searchParamFor(term: string): "requestId" | "fingerprint" | "code" {
  const s = term.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "requestId";
  if (/^[0-9a-f]{16,}$/i.test(s)) return "fingerprint";
  return "code";
}

/** First line of a stack, or the message: what an admin scans down the column for. */
function headline(row: ErrorRow): string {
  const msg = (row.message ?? "").trim();
  if (msg) return msg;
  const first = (row.stack ?? "").split("\n")[0]?.trim();
  return first || "(no message)";
}

/** The error board: what is repeating, then every event, then the one you opened. */
export default function AdminErrorsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [env, setEnv] = useState("");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [term, setTerm] = useState("");

  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  /**
   * `append` is what separates "Load more" from every other change.
   *
   * Changing a filter replaces the list and drops the cursor; loading more adds to it. Getting
   * this the wrong way round is how a paginated table starts showing the same page twice.
   */
  const load = useCallback(
    async (append: boolean, from: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: "100" });
        if (env) qs.set("env", env);
        if (severity) qs.set("severity", severity);
        if (category) qs.set("category", category);
        const t = term.trim();
        if (t) qs.set(searchParamFor(t), t);
        if (append && from) qs.set("cursor", from);

        const json = await fetchJson<ErrorsResponse>(`/api/admin/errors?${qs.toString()}`);
        const items = Array.isArray(json.items) ? json.items : [];
        setRows((prev) => (append ? [...prev, ...items] : items));
        setCursor(json.nextCursor ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load errors");
        if (!append) setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [env, severity, category, term],
  );

  useEffect(() => {
    if (!canUseAdmin) return;
    setOpenId(null);
    void load(false, null);
  }, [canUseAdmin, load]);

  /** The heaviest fingerprints in what is loaded. See the file header on why that caveat matters. */
  const recurring = useMemo(() => {
    const byPrint = new Map<string, { count: number; row: ErrorRow }>();
    for (const r of rows) {
      const key = r.fingerprint;
      if (!key) continue;
      const seen = byPrint.get(key);
      if (seen) seen.count += 1;
      else byPrint.set(key, { count: 1, row: r });
    }
    return [...byPrint.entries()]
      .map(([fingerprint, v]) => ({ fingerprint, ...v }))
      .filter((g) => g.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
  }, [rows]);

  const errorCount = rows.filter((r) => r.severity === "error").length;
  const open = openId ? (rows.find((r) => r.id === openId) ?? null) : null;

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Errors" description={DESCRIPTION} callbackUrl="/a/errors" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Errors" description={DESCRIPTION} />

        {error ? <AdminAlert className="mt-3">{error}</AdminAlert> : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <StatTile label="Loaded" value={String(rows.length)} hint={cursor ? "More to load" : "Everything matching"} />
          <StatTile label="Errors" value={String(errorCount)} hint="Severity error, not warn or info" />
          <StatTile
            label="Distinct faults"
            value={String(new Set(rows.map((r) => r.fingerprint).filter(Boolean)).size)}
            hint="Unique fingerprints in the rows loaded"
          />
        </div>

        {recurring.length ? (
          <AdminSection
            title="Repeating"
            description="The same fault more than once in the rows loaded — not a count over the whole collection. Open one to filter down to it."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {recurring.map((g) => (
                <button
                  key={g.fingerprint}
                  type="button"
                  onClick={() => setTerm(g.fingerprint)}
                  className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5 text-left transition-colors hover:border-[var(--muted-2)] hover:bg-[var(--panel-hover)]"
                >
                  <div className="flex items-center gap-2">
                    <StatusPill tone={SEVERITY_TONE[g.row.severity ?? ""] ?? "neutral"}>{g.count}×</StatusPill>
                    <span className="truncate text-xs font-semibold text-[var(--fg)]">{g.row.code ?? g.row.category ?? "error"}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-[var(--muted)]" title={headline(g.row)}>
                    {headline(g.row)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted-2)]">{g.row.route ?? ADMIN_DASH}</div>
                </button>
              ))}
            </div>
          </AdminSection>
        ) : null}

        <AdminSection
          title="Events"
          description="Newest first. With no filter the API answers the last 24 hours; with one, up to 30 days."
        >
          <AdminFilterBar
            loading={loading}
            actions={
              <Button variant="secondary" size="sm" onClick={() => void load(false, null)} disabled={loading}>
                Refresh
              </Button>
            }
          >
            <AdminSearchInput
              value={term}
              onValueChange={setTerm}
              placeholder="Code, request id or fingerprint"
              ariaLabel="Search by code, request id or fingerprint"
            />
            <AdminSelect ariaLabel="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
            </AdminSelect>
            <AdminSelect ariaLabel="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Any area</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </AdminSelect>
            <AdminSelect ariaLabel="Filter by environment" value={env} onChange={(e) => setEnv(e.target.value)}>
              <option value="">Any environment</option>
              <option value="production">production</option>
              <option value="preview">preview</option>
              <option value="development">development</option>
            </AdminSelect>
          </AdminFilterBar>

          <AdminTable
            ariaLabel="Error events"
            head={
              <>
                <AdminTh align="right">When</AdminTh>
                <AdminTh>Severity</AdminTh>
                <AdminTh>Area</AdminTh>
                <AdminTh>What happened</AdminTh>
                <AdminTh>Where</AdminTh>
                <AdminTh align="right">Status</AdminTh>
                <AdminTh>Request</AdminTh>
              </>
            }
          >
            {loading && !rows.length ? (
              <AdminTableMessage colSpan={7}>Loading errors…</AdminTableMessage>
            ) : !rows.length ? (
              <AdminTableEmpty
                colSpan={7}
                title="Nothing recorded"
                hint={
                  term || severity || category || env
                    ? "No event matches these filters in the window the API allows."
                    : "No 5xx in the last 24 hours. ERROR_LOGGING_ENABLED must be true for production to record any."
                }
              />
            ) : (
              rows.map((r) => (
                <AdminTr key={r.id} onClick={() => setOpenId(r.id === openId ? null : r.id)}>
                  <AdminTd align="right" numeric>
                    <TimeCell value={r.createdAt} />
                  </AdminTd>
                  <AdminTd>
                    <StatusPill tone={SEVERITY_TONE[r.severity ?? ""] ?? "neutral"}>{r.severity ?? ADMIN_DASH}</StatusPill>
                  </AdminTd>
                  <AdminTd>{r.category ?? ADMIN_DASH}</AdminTd>
                  <AdminTd primary truncate="max-w-[360px]">
                    <span title={headline(r)}>{headline(r)}</span>
                  </AdminTd>
                  <AdminTd mono truncate="max-w-[240px]">
                    <span title={`${r.method ?? ""} ${r.route ?? ""}`.trim() || undefined}>
                      {r.route ? `${r.method ? `${r.method} ` : ""}${r.route}` : ADMIN_DASH}
                    </span>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {r.statusCode ?? ADMIN_DASH}
                  </AdminTd>
                  <AdminTd>
                    {r.requestId ? <IdCell value={r.requestId} label="request id" /> : <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>}
                  </AdminTd>
                </AdminTr>
              ))
            )}
          </AdminTable>

          {cursor ? (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => void load(true, cursor)} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </AdminSection>

        {open ? (
          <AdminSection title="Detail" description="The row you opened. Click it again in the table to close this.">
            <DetailPanel
              title={open.code ?? headline(open)}
              description={headline(open)}
              actions={
                <Button variant="secondary" size="sm" onClick={() => setOpenId(null)}>
                  Close
                </Button>
              }
            >
              <DetailRow label="When">
                <TimeCell value={open.createdAt} />
              </DetailRow>
              <DetailRow label="Last seen">
                <TimeCell value={open.lastSeenAt} />
              </DetailRow>
              <DetailRow label="Environment">{open.env ?? ADMIN_DASH}</DetailRow>
              <DetailRow label="Route">{open.route ? `${open.method ? `${open.method} ` : ""}${open.route}` : ADMIN_DASH}</DetailRow>
              <DetailRow label="Fingerprint">
                {open.fingerprint ? <IdCell value={open.fingerprint} label="fingerprint" /> : ADMIN_DASH}
              </DetailRow>
              <DetailRow label="Workspace">
                {open.workspaceId ? (
                  <IdCell value={open.workspaceId} label="workspace id" href={`/a/data/workspaces/${encodeURIComponent(open.workspaceId)}`} />
                ) : (
                  ADMIN_DASH
                )}
              </DetailRow>
              <DetailRow label="User">
                {open.userId ? <IdCell value={open.userId} label="user id" href={`/a/data/users/${encodeURIComponent(open.userId)}`} /> : ADMIN_DASH}
              </DetailRow>
              <DetailRow label="Document">
                {open.docId ? <IdCell value={open.docId} label="doc id" href={`/a/data/docs/${encodeURIComponent(open.docId)}`} /> : ADMIN_DASH}
              </DetailRow>
              <DetailRow label="Model">{open.model ?? ADMIN_DASH}</DetailRow>
            </DetailPanel>

            {open.stack ? (
              <div className="mt-3">
                <JsonBlock text={open.stack} maxHeight="max-h-[420px]" />
              </div>
            ) : null}

            {open.meta && Object.keys(open.meta as Record<string, unknown>).length ? (
              <div className="mt-3">
                <JsonBlock text={JSON.stringify(open.meta, null, 2)} />
              </div>
            ) : null}
          </AdminSection>
        ) : null}
      </div>
    </div>
  );
}
