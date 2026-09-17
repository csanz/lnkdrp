"use client";

import { ClipboardDocumentCheckIcon, InboxArrowDownIcon, Square2StackIcon } from "@heroicons/react/24/outline";
import { useState, type Dispatch, type SetStateAction } from "react";
import DocActionsMenu from "@/components/DocActionsMenu";
import Modal from "@/components/modals/Modal";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { parsePlanLimitError, planLimitGraceHint } from "@/lib/client/planLimit";
import { upsellKeyForLimit } from "@/lib/client/upsellCopy";
import { refreshPlan } from "@/lib/client/usePlan";
import { notifyDocsChanged, notifyProjectsChanged } from "@/lib/sidebarCache";
import { buildPublicShareUrl } from "@/lib/urls";

export type SidebarDocsView = "docs" | "archived";

const DOCS_VIEWS: Array<{ id: SidebarDocsView; label: string }> = [
  { id: "docs", label: "Docs" },
  { id: "archived", label: "Archived" },
];

type DocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  receivedViaRequestProjectId?: string | null;
  guideForRequestProjectId?: string | null;
  previewImageUrl?: string | null;
  one_liner?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

/**
 * Render the SidebarDocsModal UI: every document, with a Docs / Archived switch. Archived rows carry
 * an Unarchive button (the same PATCH the MCP's lnkdrp_archive_doc archived: false uses); a Free
 * workspace at its document cap gets the upgrade modal instead, as from the "..." menu.
 */
export default function SidebarDocsModal({
  open,
  view,
  onViewChange,
  onModalClose,
  onDismiss,
  routerPush,
  docsQuery,
  setDocsQuery,
  docsModal,
  setDocsModal,
  docsThumbAspectById,
  setDocsThumbAspectById,
  hideCopyIconShareId,
  setHideCopyIconShareId,
  copiedShareId,
  copyDocLink,
  formatRelative,
}: {
  open: boolean;
  view: SidebarDocsView;
  onViewChange: (next: SidebarDocsView) => void;
  onModalClose: () => void;
  onDismiss: () => void;
  routerPush: (href: string) => void;
  docsQuery: string;
  setDocsQuery: (v: string) => void;
  docsModal: Paged<DocListItem>;
  setDocsModal: Dispatch<SetStateAction<Paged<DocListItem>>>;
  docsThumbAspectById: Record<string, number>;
  setDocsThumbAspectById: Dispatch<SetStateAction<Record<string, number>>>;
  hideCopyIconShareId: string | null;
  setHideCopyIconShareId: (v: string | null) => void;
  copiedShareId: string | null;
  copyDocLink: (shareId: string) => void | Promise<void>;
  formatRelative: (iso: string | null) => string;
}) {
  const archivedView = view === "archived";
  const { openUpgrade } = useUpgradeModal();
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const [unarchiveError, setUnarchiveError] = useState<{ id: string; message: string } | null>(null);

  async function unarchive(id: string) {
    if (unarchivingId) return;
    setUnarchivingId(id);
    setUnarchiveError(null);
    try {
      const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isArchived: false }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const limitErr = res.status === 402 ? parsePlanLimitError(json) : null;
        if (limitErr) {
          openUpgrade(upsellKeyForLimit(limitErr.limit), { used: limitErr.used, max: limitErr.max, graceHint: planLimitGraceHint(limitErr) });
          return;
        }
        throw new Error(typeof json?.error === "string" && json.error ? json.error : `Request failed (${res.status})`);
      }
      setDocsModal((s) => ({ ...s, items: s.items.filter((x) => x.id !== id), total: Math.max(0, s.total - 1) }));
      notifyDocsChanged();
      notifyProjectsChanged();
      refreshPlan();
    } catch (e) {
      setUnarchiveError({ id, message: e instanceof Error ? e.message : "Failed to unarchive" });
    } finally {
      setUnarchivingId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onModalClose}
      ariaLabel="Docs"
      panelClassName="w-[min(860px,calc(100vw-32px))]"
      contentClassName="h-[min(82vh,860px)] max-h-none overflow-hidden px-6 pb-6 pt-5"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 pr-10">
          <div className="text-base font-semibold text-[var(--fg)]">Docs</div>
          <div className="text-xs text-[var(--muted-2)]">
            {docsModal.total ? `${docsModal.total} ${archivedView ? "archived" : "total"}` : ""}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Documents">
          {DOCS_VIEWS.map((v) => {
            const active = v.id === view;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (active) return;
                  setUnarchiveError(null);
                  onViewChange(v.id);
                }}
                className={[
                  "h-8 rounded-full px-3 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  active
                    ? "bg-[var(--fg)] text-[var(--bg)]"
                    : "border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        <div className="mt-3">
          <input
            autoFocus
            value={docsQuery}
            onChange={(e) => {
              setDocsQuery(e.target.value);
              setDocsModal((s) => ({ ...s, page: 1 }));
            }}
            placeholder={archivedView ? "Search archived docs" : "Search"}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
          />
        </div>

        <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {archivedView && !docsModal.items.length ? (
            <li className="px-3 py-6 text-[13px] text-[var(--muted-2)]">
              {docsQuery.trim()
                ? "No archived docs match that search."
                : "No archived docs. Archiving keeps a document's links and analytics; it comes back here to unarchive."}
            </li>
          ) : null}
          {docsModal.items.map((d) => {
            const href = `/doc/${d.id}`;
            const when = formatRelative(d.updatedDate ?? d.createdDate);
            const previewImageUrl =
              typeof d.previewImageUrl === "string" && d.previewImageUrl.trim() ? d.previewImageUrl.trim() : null;
            const oneLiner = typeof d.one_liner === "string" && d.one_liner.trim() ? d.one_liner.trim() : "";
            const aspect = docsThumbAspectById[d.id];
            const aspectClamped =
              typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0 ? Math.max(0.55, Math.min(2.2, aspect)) : null;
            const isRequestDoc = Boolean(
              (typeof d.receivedViaRequestProjectId === "string" && d.receivedViaRequestProjectId.trim()) ||
                (typeof d.guideForRequestProjectId === "string" && d.guideForRequestProjectId.trim()),
            );

            return (
              <li key={d.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="group rounded-xl border border-transparent px-3 py-2 text-[13px] hover:bg-[var(--panel-hover)] focus:border-[var(--border)] focus:outline-none"
                  title={when ? `Updated ${when}` : undefined}
                  onClick={() => {
                    onDismiss();
                    routerPush(href);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    // Only the row itself: Enter/Space on a button inside it (copy link, the "..."
                    // menu) must press that button, not open the document.
                    if (e.target !== e.currentTarget) return;
                    e.preventDefault();
                    onDismiss();
                    routerPush(href);
                  }}
                  onMouseEnter={() => {
                    if (d.shareId && hideCopyIconShareId === d.shareId) {
                      setHideCopyIconShareId(null);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div
                        className="relative mt-0.5 h-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel-hover)]"
                        style={{
                          aspectRatio: aspectClamped ?? 0.75,
                          maxWidth: 128,
                        }}
                      >
                        {previewImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={previewImageUrl}
                            alt=""
                            className="h-full w-full object-contain"
                            loading="lazy"
                            decoding="async"
                            onLoad={(e) => {
                              const img = e.currentTarget;
                              const w = img.naturalWidth;
                              const h = img.naturalHeight;
                              if (!w || !h) return;
                              const next = w / h;
                              if (!Number.isFinite(next) || next <= 0) return;
                              setDocsThumbAspectById((prev) => {
                                if (prev[d.id]) return prev;
                                return { ...prev, [d.id]: next };
                              });
                            }}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-[var(--muted-2)]">
                            PDF
                          </div>
                        )}
                      </div>

                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex max-w-full min-w-0 items-center gap-2 text-[13px] font-semibold leading-4 text-[var(--fg)]">
                          {isRequestDoc ? (
                            <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                          ) : (
                            <DocFileIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" />
                          )}
                          <span className="block min-w-0 flex-1 truncate">{d.title}</span>
                          {typeof d.version === "number" && Number.isFinite(d.version) ? (
                            <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                              v{d.version}
                            </span>
                          ) : (d.status ?? "").toLowerCase() === "preparing" ? (
                            <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                              v…
                            </span>
                          ) : null}
                        </div>
                        {oneLiner ? <div className="mt-1 line-clamp-2 text-[12px] text-[var(--muted-2)]">{oneLiner}</div> : null}
                        {unarchiveError?.id === d.id ? (
                          <div className="mt-1 text-[12px] text-red-500" role="alert">
                            {unarchiveError.message}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {archivedView ? (
                        <button
                          type="button"
                          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                          disabled={unarchivingId !== null}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void unarchive(d.id);
                          }}
                        >
                          {unarchivingId === d.id ? "Unarchiving…" : "Unarchive"}
                        </button>
                      ) : null}
                      {d.shareId && !archivedView ? (
                        <button
                          type="button"
                          className={[
                            "shrink-0 rounded-md p-0.5 text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                            hideCopyIconShareId === d.shareId && copiedShareId !== d.shareId
                              ? "opacity-0"
                              : "opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100",
                          ].join(" ")}
                          aria-label="Copy doc link"
                          title={copiedShareId === d.shareId ? "Copied" : `Copy ${buildPublicShareUrl(d.shareId)}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const shareId = d.shareId;
                            if (!shareId) return;
                            void copyDocLink(shareId);
                          }}
                        >
                          {copiedShareId === d.shareId ? (
                            <ClipboardDocumentCheckIcon className="h-4 w-4" />
                          ) : (
                            <Square2StackIcon className="h-4 w-4" />
                          )}
                        </button>
                      ) : null}
                      <DocActionsMenu
                        docId={d.id}
                        variant="ghost"
                        className="flex"
                        projectsLabel="Move to project"
                        showArchive
                        isArchived={archivedView}
                        showDelete={false}
                        onDocPatched={(patch) => {
                          // Archived or unarchived: the row moves to the other tab; the docs-changed refetch reconciles the page.
                          if (typeof patch.isArchived !== "boolean" || patch.isArchived === archivedView) return;
                          setDocsModal((s) => ({
                            ...s,
                            items: s.items.filter((x) => x.id !== d.id),
                            total: Math.max(0, s.total - 1),
                          }));
                        }}
                      />
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={docsModal.page <= 1}
            onClick={() => setDocsModal((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
          >
            Prev
          </button>
          <div className="text-xs text-[var(--muted-2)]">
            Page {docsModal.page} / {Math.max(1, Math.ceil(docsModal.total / docsModal.limit))}
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={docsModal.page >= Math.ceil(docsModal.total / docsModal.limit)}
            onClick={() => setDocsModal((s) => ({ ...s, page: s.page + 1 }))}
          >
            Next
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DocFileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
      />
    </svg>
  );
}


