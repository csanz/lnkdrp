/**
 * Admin route: `/a/data/projects`
 *
 * Lists projects across all users (paged) for admin inspection. Built on the shared admin
 * UI in `@/components/admin` — see `/a/data/users` for the reference implementation.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  RowAction,
  RowActionLink,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH, ADMIN_FOCUS_RING } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type ProjectRow = {
  id: string;
  userId: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  docCount: number | null;
  isRequest: boolean;
  /** Which capability tokens exist on the row — never their values. See src/lib/admin/docPrivacy.ts. */
  secrets?: { hasShareLink?: boolean | null; hasRequestUploadToken?: boolean | null } | null;
  updatedDate: string | null;
  createdDate: string | null;
};

/** Column count of the table below; every full-width row's colSpan has to match it. */
const COLUMN_COUNT = 6;

/** The Projects browser: every project and request repo, filtered and paged server-side. */
export default function AdminDataProjectsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteBusyProjectId, setDeleteBusyProjectId] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  /** A search narrowing the list — decides which empty-state sentence the table shows. */
  const filtered = Boolean(q.trim());

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
        const data = await fetchJson<{ projects?: unknown; total?: unknown }>(`/api/admin/data/projects?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.projects) ? (data.projects as ProjectRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load projects");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q, reloadKey]);

  /** Soft-delete a project, then drop its row optimistically. */
  async function deleteProject(projectId: string) {
    if (!projectId) return;
    if (deleteBusyProjectId) return;
    const ok = window.confirm(`Soft-delete project ${projectId}?\n\nThis will hide it from normal views.`);
    if (!ok) return;
    setDeleteBusyProjectId(projectId);
    setError(null);
    try {
      await fetchJson(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      setItems((prev) => prev.filter((p) => p.id !== projectId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete project");
    } finally {
      setDeleteBusyProjectId("");
    }
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Projects" description="Every project and request repo across all users, newest activity first." callbackUrl="/a/data/projects" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title="Projects" description="Every project and request repo across all users, newest activity first." />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="projects"
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
            placeholder="Search name, slug, shareId…"
            ariaLabel="Search projects by name, slug, shareId or token"
          />
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <AdminTable
          className="mt-3"
          ariaLabel="Projects"
          head={
            <>
              {/* Name carries the slack. Type, Token and User were one repeated value on
                  every row of the page; all three are on the project's own detail page. */}
              <AdminTh>Name</AdminTh>
              <AdminTh width="w-[120px]">Kind</AdminTh>
              <AdminTh align="right" width="w-[70px]">Docs</AdminTh>
              <AdminTh align="right" width="w-[130px]">Updated</AdminTh>
              <AdminTh width="w-[130px]">Project ID</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {loading && items.length === 0 ? (
            <AdminTableMessage colSpan={COLUMN_COUNT}>Loading projects…</AdminTableMessage>
          ) : items.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={filtered ? "No projects match that search" : "No projects yet"}
              hint={filtered ? "Try a different name, slug, shareId or token." : undefined}
            />
          ) : (
            items.map((p) => {
              // A repo whose `isRequest` was never backfilled still has an upload token, and the
              // flag says so without the page ever holding the token.
              const isRequest = Boolean(p.isRequest || p.secrets?.hasRequestUploadToken);
              return (
                <AdminTr key={p.id}>
                  {/* The description is the row's tooltip rather than a second line: one project
                      per line keeps the vertical rhythm, and the full text is still readable. */}
                  {/* The phone cap is what makes the ellipsis render at 390px: uncapped, the
                      name column takes its natural width and the pinned Actions cell slices
                      the name mid-word with no "…". */}
                  <AdminTd primary truncate="max-w-[190px] sm:max-w-[520px]">
                    <Link
                      href={`/a/data/projects/${encodeURIComponent(p.id)}`}
                      className={cn("block truncate rounded hover:underline", ADMIN_FOCUS_RING)}
                      title={[p.name ?? "Untitled", p.slug ? `/${p.slug}` : "", p.description ?? ""]
                        .filter(Boolean)
                        .join(" — ")}
                    >
                      {p.name ?? ADMIN_DASH}
                    </Link>
                  </AdminTd>
                  <AdminTd>
                    {/* A "Project" pill on all 28 rows is decoration. Only the exception —
                        a request repo — gets a chip; the default is a plain word. */}
                    {isRequest ? (
                      <StatusPill tone="info">Request</StatusPill>
                    ) : (
                      <span className="text-[var(--muted-2)]">Project</span>
                    )}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {typeof p.docCount === "number" ? p.docCount.toLocaleString() : ADMIN_DASH}
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    <TimeCell value={p.updatedDate ?? p.createdDate} />
                  </AdminTd>
                  <AdminTd>
                    <IdCell value={p.id} label="project id" href={`/a/data/projects/${encodeURIComponent(p.id)}`} />
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    <RowActions>
                      {/* Same right-hand shape as Docs, Uploads and Links: one primary action
                          that opens the row, then the destructive one last. */}
                      <RowActionLink href={`/a/data/projects/${encodeURIComponent(p.id)}`} title="Open project details">
                        Details
                      </RowActionLink>
                      <RowAction
                        tone="danger"
                        busy={deleteBusyProjectId === p.id}
                        busyLabel="Deleting…"
                        disabled={Boolean(deleteBusyProjectId) && deleteBusyProjectId !== p.id}
                        title="Soft delete project"
                        onClick={() => void deleteProject(p.id)}
                      >
                        Delete
                      </RowAction>
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
