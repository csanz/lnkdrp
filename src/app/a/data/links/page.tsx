/**
 * Admin route: `/a/data/links`
 *
 * Share-link browser: every public link across every workspace, paged, with the settings support
 * actually gets asked about (password set, download allowed, expiry, disabled) and the link's own
 * view/download counters. Read-only — nothing here changes a link.
 *
 * Two of the twelve columns this table used to carry are gone, because twelve did not fit and the
 * last three scrolled off the right edge where nobody found them. Expiry is answered by the
 * `Expired` state pill, with the exact timestamp in its `title`; audience, which was `—` on almost
 * every row, rides in the Link cell's `title`. Nothing is lost, and the ones that remain fit.
 *
 * The Slug column is gone for a different reason, and this one is not a layout call. `/s/:shareId`
 * renders the customer's document, so a page of slugs filtered to `hasPassword: false` was a page
 * of documents any staff account could open — and opening one writes a real recipient view into
 * that customer's analytics, because an admin is not a member of their workspace. The route stops
 * sending the slug; the search box above still matches one, so a slug a customer actually gave you
 * finds its row.
 */
"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  RowActionLink,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, ADMIN_FOCUS_RING, fmtAdminDateFull, type AdminTone } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { linkStateLabel, type AdminLinkState } from "@/lib/admin/linksAdmin";
import { fetchJson } from "@/lib/http/fetchJson";

type LinkRow = {
  id: string;
  kind: string;
  label: string | null;
  audience: string | null;
  isDefault: boolean;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceType: string | null;
  docId: string | null;
  docTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  state: AdminLinkState;
  disabledByDocSwitch: boolean;
  allowDownload: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  createdVia: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  downloadCount: number;
  createdDate: string | null;
};

type SortField = "createdDate" | "lastViewedAt" | "viewCount";
type SortOrder = "desc" | "asc";

/** Column count of the table below; the empty row's colSpan has to match it exactly. */
const COLUMN_COUNT = 8;

/**
 * One state scale, and the STATE column is the only place on the page that uses a strong tone.
 *
 * The colours used to be inverted: `archived` — the normal, expected end of a link's life, and a
 * third of all rows — was the loudest red on the page, while `active`, the state an admin is
 * actually looking for, was the quietest grey. `disabled`, `expired` and `doc off` shared one
 * amber, so three different meanings looked identical.
 *
 * Now: live is the one positive colour; a link that will not resolve is the one danger colour;
 * a link switched off upstream (and recoverable by flipping the document back on) is the one
 * warning; retired is neutral. `toneStyle()` mixes each hue against the theme's own `--fg` and
 * `--panel`, so the pair means the same thing in light and in dark.
 */
const STATE_TONE: Record<AdminLinkState, AdminTone> = {
  active: "positive",
  disabled: "danger",
  expired: "danger",
  archived: "neutral",
};

/** The Links browser: every share link across workspaces, filtered and paged server-side. */
export default function AdminDataLinksPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdDate");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** Any filter narrowing the list — decides which empty-state sentence the table shows. */
  const filtered = Boolean(q.trim() || stateFilter || kindFilter);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        if (stateFilter) qs.set("state", stateFilter);
        if (kindFilter) qs.set("kind", kindFilter);
        qs.set("sort", sortField);
        qs.set("order", sortOrder);
        const data = await fetchJson<{ links?: unknown; total?: unknown }>(
          `/api/admin/data/links?${qs.toString()}`,
          { method: "GET" },
        );
        setItems(Array.isArray(data.links) ? (data.links as LinkRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share links");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, stateFilter, kindFilter, sortField, sortOrder, reloadKey]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Links" description="Every share link across workspaces. Counts are the link’s own and drift from share views." callbackUrl="/a/data/links" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Links"
          description="Every share link across workspaces. Counts are the link’s own and drift from share views."
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="links"
          loading={loading}
          actions={
            <Button variant="outline" className="bg-[var(--panel)]" disabled={loading} onClick={() => setReloadKey((v) => v + 1)}>
              {loading ? "Loading…" : "Refresh"}
            </Button>
          }
        >
          <AdminSearchInput
            value={q}
            onValueChange={(v) => {
              setPage(1);
              setQ(v);
            }}
            placeholder="Search label, audience or slug…"
            ariaLabel="Search share links by label, audience or slug"
          />
          <AdminSelect
            ariaLabel="Filter by state"
            value={stateFilter}
            onChange={(e) => {
              setPage(1);
              setStateFilter(e.target.value);
            }}
          >
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="expired">Expired</option>
            <option value="archived">Archived</option>
            <option value="password">Password-protected</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Filter by kind"
            value={kindFilter}
            onChange={(e) => {
              setPage(1);
              setKindFilter(e.target.value);
            }}
          >
            <option value="">All links</option>
            <option value="doc">Document links</option>
            <option value="project">Project links</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Sort share links"
            value={`${sortField}:${sortOrder}`}
            onChange={(e) => {
              const raw = e.target.value || "createdDate:desc";
              const [f, o] = raw.split(":");
              const nextField = (f === "lastViewedAt" || f === "viewCount" ? f : "createdDate") as SortField;
              const nextOrder = (o === "asc" ? "asc" : "desc") as SortOrder;
              setPage(1);
              setSortField(nextField);
              setSortOrder(nextOrder);
            }}
          >
            <option value="createdDate:desc">Created (newest)</option>
            <option value="createdDate:asc">Created (oldest)</option>
            <option value="lastViewedAt:desc">Last viewed (newest)</option>
            <option value="viewCount:desc">Views (most)</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Share links"
          head={
            <>
              {/* The target document is what tells two rows apart, so it leads; the link's own
                  label ("Default link" on four rows in five) is the secondary column. The
                  workspace name rides in the target's tooltip — it costs a column and repeats. */}
              <AdminTh>Target</AdminTh>
              <AdminTh>Link</AdminTh>
              <AdminTh width="w-[96px]">State</AdminTh>
              <AdminTh width="w-[160px]">Access</AdminTh>
              <AdminTh align="right" width="w-[70px]">Views</AdminTh>
              <AdminTh align="right" width="w-[90px]">Downloads</AdminTh>
              <AdminTh align="right" width="w-[130px]">Created</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading share links…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={filtered ? "No share links match that search" : "No share links yet"}
              hint={filtered ? "Try a different label, state or kind." : undefined}
            />
          ) : (
            items.map((l) => {
              const target = l.kind === "project" ? l.projectName : l.docTitle;
              const stateLabel = linkStateLabel(l.state, { disabledByDocSwitch: l.disabledByDocSwitch });
              // Audience has no column of its own — it is a short tag that was mostly empty and cost
              // the table its last 100px — so it rides in the Link cell's tooltip instead.
              const linkTitle = [l.label ?? "Unnamed link", l.audience ? `audience: ${l.audience}` : null]
                .filter(Boolean)
                .join(" · ");
              // The workspace name has no column of its own — it repeats down the page and cost
              // the table 105px — so it rides in the target's tooltip.
              const targetTitle = [target ?? "No target", l.workspaceName ? `workspace: ${l.workspaceName}` : null]
                .filter(Boolean)
                .join(" · ");
              const stateTone: AdminTone =
                l.state === "disabled" && l.disabledByDocSwitch ? "warning" : (STATE_TONE[l.state] ?? "quiet");
              // The pill shows one word; the reason and the expiry date live in its tooltip, so the
              // State column stays narrow while still answering "why isn't this link working?".
              const stateTitle = [
                stateLabel,
                l.expiresAt ? `Expires ${fmtAdminDateFull(l.expiresAt)}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <AdminTr key={l.id}>
                  {/* Em dash when the document or project row is gone: the link keeps its own
                      analytics, so the row is still worth listing without a name. */}
                  <AdminTd primary truncate="max-w-[205px]">
                    {l.docId ? (
                      <Link
                        href={`/a/shareviews/${encodeURIComponent(l.docId)}`}
                        className={cn("block truncate rounded hover:underline", ADMIN_FOCUS_RING)}
                        title={targetTitle}
                      >
                        {target ?? ADMIN_DASH}
                      </Link>
                    ) : (
                      <span title={targetTitle}>{target ?? ADMIN_DASH}</span>
                    )}
                  </AdminTd>
                  <AdminTd truncate="max-w-[134px]">
                    {/* No "default" chip beside a label that already reads "Default link". */}
                    <span title={linkTitle}>{l.label ?? (l.isDefault ? "Default link" : ADMIN_DASH)}</span>
                  </AdminTd>
                  <AdminTd>
                    <StatusPill tone={stateTone} title={stateTitle}>
                      {l.state === "disabled" && l.disabledByDocSwitch ? "Doc off" : linkStateLabel(l.state)}
                    </StatusPill>
                  </AdminTd>
                  <AdminTd>
                    {/* Permissions, not states: quiet chips, so they never outshout the STATE
                        column. Whether a password is set — never the password or its hash. */}
                    <span className="inline-flex items-center gap-1.5">
                      {l.hasPassword ? (
                        <StatusPill tone="quiet" title="A password is set on this link">
                          Password
                        </StatusPill>
                      ) : null}
                      {l.allowDownload ? (
                        <StatusPill tone="quiet" title="Viewers may download the file">
                          Download
                        </StatusPill>
                      ) : null}
                      {!l.hasPassword && !l.allowDownload ? (
                        <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      ) : null}
                    </span>
                  </AdminTd>
                  <AdminTd align="right" numeric title="The link's own view counter">
                    {Number.isFinite(l.viewCount) ? l.viewCount.toLocaleString() : ADMIN_DASH}
                  </AdminTd>
                  <AdminTd align="right" numeric title="The link's own download counter">
                    {Number.isFinite(l.downloadCount) ? l.downloadCount.toLocaleString() : ADMIN_DASH}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={l.createdDate} />
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    {/* Links had no right-hand affordance at all, and no cue that a row opened
                        anything. Same shape as every other list page: one primary action. */}
                    <RowActions>
                      {l.docId ? (
                        <RowActionLink
                          href={`/a/shareviews/${encodeURIComponent(l.docId)}`}
                          title="Who viewed this document"
                        >
                          Views
                        </RowActionLink>
                      ) : l.projectId ? (
                        <RowActionLink
                          href={`/a/data/projects/${encodeURIComponent(l.projectId)}`}
                          title="Open the project behind this link"
                        >
                          Project
                        </RowActionLink>
                      ) : (
                        <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      )}
                    </RowActions>
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>
      </div>
    </div>
  );
}
