"use client";

import { InboxArrowDownIcon } from "@heroicons/react/24/outline";
import type { Dispatch, SetStateAction } from "react";
import Modal from "@/components/modals/Modal";

type RequestListItem = {
  id: string;
  name: string;
  description: string;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

/**
 * Render the SidebarRequestsModal UI.
 */
export default function SidebarRequestsModal({
  open,
  onClose,
  routerPush,
  requestsQuery,
  setRequestsQuery,
  requestsModal,
  setRequestsModal,
  formatRelative,
}: {
  open: boolean;
  onClose: () => void;
  routerPush: (href: string) => void;
  requestsQuery: string;
  setRequestsQuery: (v: string) => void;
  requestsModal: Paged<RequestListItem>;
  setRequestsModal: Dispatch<SetStateAction<Paged<RequestListItem>>>;
  formatRelative: (iso: string | null) => string;
}) {
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setRequestsQuery("");
        setRequestsModal((s) => ({ ...s, page: 1 }));
      }}
      ariaLabel="Received (request inboxes)"
      panelClassName="w-[min(860px,calc(100vw-32px))]"
      contentClassName="h-[min(82vh,860px)] max-h-none overflow-hidden px-6 pb-6 pt-5"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 pr-10">
          <div className="inline-flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
            <InboxArrowDownIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
            <span>Received</span>
          </div>
          <div className="text-xs text-[var(--muted-2)]">
            {requestsModal.total ? `${requestsModal.total} total` : ""}
          </div>
        </div>

        <div className="mt-3">
          <input
            value={requestsQuery}
            onChange={(e) => {
              setRequestsQuery(e.target.value);
              setRequestsModal((s) => ({ ...s, page: 1 }));
            }}
            placeholder="Search inboxes"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
          />
        </div>

        <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {requestsModal.items.map((p) => {
            const when = formatRelative(p.updatedDate ?? p.createdDate);
            return (
              <li key={p.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="rounded-xl border border-transparent px-3 py-2 text-[13px] hover:bg-[var(--panel-hover)] focus:border-[var(--border)] focus:outline-none"
                  onClick={() => {
                    onClose();
                    routerPush(`/project/${encodeURIComponent(p.id)}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onClose();
                    routerPush(`/project/${encodeURIComponent(p.id)}`);
                  }}
                  title={p.description || undefined}
                >
                  <div className="flex min-w-0 items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--fg)]">
                        <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                        <span className="block min-w-0 flex-1 truncate">{p.name || "Request inbox"}</span>
                        {typeof p.docCount === "number" && Number.isFinite(p.docCount) ? (
                          <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                            {p.docCount}
                          </span>
                        ) : null}
                      </div>
                      {p.description ? (
                        <div className="mt-1 line-clamp-2 text-[12px] text-[var(--muted-2)]">{p.description}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-[var(--muted-2)]">{when || "-"}</div>
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
            disabled={requestsModal.page <= 1}
            onClick={() => setRequestsModal((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
          >
            Prev
          </button>
          <div className="text-xs text-[var(--muted-2)]">
            Page {requestsModal.page} / {Math.max(1, Math.ceil(requestsModal.total / requestsModal.limit))}
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={requestsModal.page >= Math.ceil(requestsModal.total / requestsModal.limit)}
            onClick={() => setRequestsModal((s) => ({ ...s, page: s.page + 1 }))}
          >
            Next
          </button>
        </div>
      </div>
    </Modal>
  );
}


