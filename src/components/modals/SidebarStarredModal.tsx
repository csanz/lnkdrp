"use client";

import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import Modal from "@/components/modals/Modal";

type StarIconComponent = (props: { className?: string; filled?: boolean }) => ReactElement;

type StarredDoc = { id: string; title: string };

type StarredMeta = { updatedDate: string | null; createdDate: string | null };
type StarredMetaById = Record<string, StarredMeta>;
type StarredDetails = { previewImageUrl: string | null; one_liner: string | null; title: string | null };
type StarredDetailsById = Record<string, StarredDetails>;

/**
 * Render the SidebarStarredModal UI.
 */
export default function SidebarStarredModal({
  open,
  onClose,
  routerPush,
  StarIcon,
  starredQuery,
  setStarredQuery,
  setStarredModalPage,
  starredModalTotal,
  starredModalPageClamped,
  starredModalMaxPage,
  starredModalItems,
  starredValid,
  starredMetaById,
  starredDetailsById,
  docsThumbAspectById,
  setDocsThumbAspectById,
  moveStarredDoc,
  formatRelative,
}: {
  open: boolean;
  onClose: () => void;
  routerPush: (href: string) => void;
  StarIcon: StarIconComponent;
  starredQuery: string;
  setStarredQuery: (v: string) => void;
  setStarredModalPage: (v: number | ((p: number) => number)) => void;
  starredModalTotal: number;
  starredModalPageClamped: number;
  starredModalMaxPage: number;
  starredModalItems: StarredDoc[];
  starredValid: StarredDoc[];
  starredMetaById: StarredMetaById;
  starredDetailsById: StarredDetailsById;
  docsThumbAspectById: Record<string, number>;
  setDocsThumbAspectById: Dispatch<SetStateAction<Record<string, number>>>;
  moveStarredDoc: (id: string, dir: "up" | "down") => void;
  formatRelative: (iso: string | null) => string;
}) {
  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setStarredQuery("");
        setStarredModalPage(1);
      }}
      ariaLabel="Starred docs"
      panelClassName="w-[min(860px,calc(100vw-32px))]"
      contentClassName="h-[min(82vh,860px)] max-h-none overflow-hidden px-6 pb-6 pt-5"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 pr-10">
          <div className="inline-flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
            <StarIcon className="h-4 w-4 text-amber-400" filled />
            <span>Starred</span>
          </div>
          <div className="text-xs text-[var(--muted-2)]">{starredModalTotal ? `${starredModalTotal} starred` : ""}</div>
        </div>

        <div className="mt-3">
          <input
            value={starredQuery}
            onChange={(e) => {
              setStarredQuery(e.target.value);
              setStarredModalPage(1);
            }}
            placeholder="Search starred"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
          />
        </div>

        <div className="mt-2 text-[11px] text-[var(--muted-2)]">Showing starred docs only.</div>

        <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {starredModalItems.map((d) => {
            const href = `/doc/${d.id}`;
            const meta = starredMetaById[d.id] ?? null;
            const details = starredDetailsById[d.id] ?? null;
            const idxInOrder = starredValid.findIndex((x) => x.id === d.id);
            const canReorder = !starredQuery.trim() && idxInOrder >= 0;
            const canMoveUp = canReorder && idxInOrder > 0;
            const canMoveDown = canReorder && idxInOrder < starredValid.length - 1;

            const when = formatRelative(meta?.updatedDate ?? meta?.createdDate ?? null);
            const previewImageUrl =
              typeof details?.previewImageUrl === "string" && details.previewImageUrl.trim() ? details.previewImageUrl.trim() : null;
            const oneLiner = typeof details?.one_liner === "string" && details.one_liner.trim() ? details.one_liner.trim() : "";
            const aspect = docsThumbAspectById[d.id];
            const aspectClamped =
              typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0 ? Math.max(0.55, Math.min(2.2, aspect)) : null;

            return (
              <li key={d.id}>
                <div
                  role="link"
                  tabIndex={0}
                  className="group rounded-xl border border-transparent px-3 py-2 text-[13px] hover:bg-[var(--panel-hover)] focus:border-[var(--border)] focus:outline-none"
                  onClick={() => {
                    onClose();
                    routerPush(href);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onClose();
                    routerPush(href);
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
                          <StarIcon className="h-4 w-4 shrink-0 text-amber-400" filled />
                          <span className="block min-w-0 flex-1 truncate">{details?.title || d.title}</span>
                        </div>
                        {oneLiner ? <div className="mt-1 line-clamp-2 text-[12px] text-[var(--muted-2)]">{oneLiner}</div> : null}
                        <div className="mt-1 flex min-w-0 items-center gap-1 text-[12px] text-[var(--muted-2)]">
                          <span className="min-w-0 flex-1 truncate">{when || "-"}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-center gap-1 pl-1">
                      <button
                        type="button"
                        disabled={!canMoveUp}
                        className={[
                          "rounded-md p-1 text-[var(--muted-2)] hover:bg-[var(--panel)] hover:text-[var(--fg)]",
                          "opacity-70 transition-opacity hover:opacity-100 disabled:opacity-30",
                        ].join(" ")}
                        aria-label={canReorder ? "Move up" : "Move up (clear search to reorder)"}
                        title={canReorder ? "Move up" : "Clear search to reorder"}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!canMoveUp) return;
                          moveStarredDoc(d.id, "up");
                        }}
                      >
                        <ChevronUpIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={!canMoveDown}
                        className={[
                          "rounded-md p-1 text-[var(--muted-2)] hover:bg-[var(--panel)] hover:text-[var(--fg)]",
                          "opacity-70 transition-opacity hover:opacity-100 disabled:opacity-30",
                        ].join(" ")}
                        aria-label={canReorder ? "Move down" : "Move down (clear search to reorder)"}
                        title={canReorder ? "Move down" : "Clear search to reorder"}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!canMoveDown) return;
                          moveStarredDoc(d.id, "down");
                        }}
                      >
                        <ChevronDownIcon className="h-4 w-4" />
                      </button>
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
            disabled={starredModalPageClamped <= 1}
            onClick={() => setStarredModalPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <div className="text-xs text-[var(--muted-2)]">
            Page {starredModalPageClamped} / {starredModalMaxPage}
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={starredModalPageClamped >= starredModalMaxPage}
            onClick={() => setStarredModalPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </Modal>
  );
}


