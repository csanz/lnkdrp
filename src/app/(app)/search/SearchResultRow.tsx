"use client";

/**
 * Result rows for `/search`: document and project hits with subtle match highlighting.
 *
 * Rows are real `<Link>`s so keyboard users get native Enter-to-open; the page drives a roving
 * tabindex through `tabIndex` / `onFocus` and addresses rows by `data-result-index`.
 */

import Link from "next/link";
import { DocumentIcon, FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

export type SearchDoc = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  previewImageUrl: string | null;
  one_liner: string | null;
  receivedViaRequestProjectId: string | null;
  guideForRequestProjectId: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

export type SearchProject = {
  id: string;
  shareId: string | null;
  name: string;
  slug: string;
  description: string;
  isRequest: boolean;
  docCount: number;
  updatedDate: string | null;
  createdDate: string | null;
};

/** Rows beyond this index enter together (stagger stops growing) so long pages never feel slow. */
export const STAGGER_CAP = 14;
/** Same entrance keyframe the activity feed uses (`ldFeedRowIn` in globals.css). */
const ROW_ENTER_CLASS = "motion-safe:animate-[ldFeedRowIn_360ms_cubic-bezier(0.2,0.7,0.2,1)_both]";
const ROW_LINK_CLASS =
  "group flex items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-[var(--panel-hover)] focus-visible:bg-[var(--panel-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]";

/** Compact relative time ("just now", "5 mins ago", "2 hrs ago", "3 days ago", else a short date). */
export function formatRelativeShort(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "min" : "mins"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Wrap the first case-insensitive occurrence of `query` in a subtly styled `<mark>`. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-[var(--fg)]/10 px-px text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

const STATUS_META: Record<string, { label: string; dot: string }> = {
  ready: { label: "Ready", dot: "bg-emerald-500" },
  preparing: { label: "Preparing", dot: "bg-amber-500" },
  failed: { label: "Failed", dot: "bg-red-500" },
  draft: { label: "Draft", dot: "bg-[var(--muted-2)]" },
};

function StatusPill({ status }: { status: string | null }) {
  const key = (status ?? "").toLowerCase();
  const meta = STATUS_META[key] ?? STATUS_META.draft;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--panel-hover)] px-1.5 py-0 text-[10px] font-medium text-[var(--muted)] ring-1 ring-[var(--border)]">
      <span aria-hidden="true" className={["h-1.5 w-1.5 rounded-full", meta.dot].join(" ")} />
      {meta.label}
    </span>
  );
}

type RowProps = {
  /** Highlighted query. */
  query: string;
  /** Visual index within the list (drives the entrance stagger). */
  index: number;
  /** Position in the page-wide keyboard order. */
  resultIndex: number;
  tabIndex: 0 | -1;
  onFocus: (resultIndex: number) => void;
};

/** A document hit: thumbnail, highlighted title, one-liner and a meta line. */
export function DocResultRow({ doc, query, index, resultIndex, tabIndex, onFocus }: RowProps & { doc: SearchDoc }) {
  const updated = formatRelativeShort(doc.updatedDate);
  const exact = doc.updatedDate ? new Date(doc.updatedDate).toLocaleString() : undefined;
  return (
    <li style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * 28}ms` }} className={ROW_ENTER_CLASS}>
      <Link
        href={`/doc/${encodeURIComponent(doc.id)}`}
        className={ROW_LINK_CLASS}
        data-result-index={resultIndex}
        tabIndex={tabIndex}
        onFocus={() => onFocus(resultIndex)}
      >
        <div className="relative mt-0.5 h-10 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel-hover)]">
          {doc.previewImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={doc.previewImageUrl} alt="" className="h-full w-full object-cover object-top" loading="lazy" decoding="async" />
          ) : (
            <div className="grid h-full w-full place-items-center text-[var(--muted-2)]">
              <DocumentIcon className="h-5 w-5" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5 text-[var(--fg)]">
            <Highlight text={doc.title || "Untitled document"} query={query} />
          </div>
          {doc.one_liner ? (
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-[var(--muted)]">
              <Highlight text={doc.one_liner} query={query} />
            </div>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted-2)]">
            <StatusPill status={doc.status} />
            {typeof doc.version === "number" && Number.isFinite(doc.version) ? (
              <span className="tabular-nums">v{doc.version}</span>
            ) : null}
            {updated ? (
              <time dateTime={doc.updatedDate ?? undefined} title={exact}>
                Updated {updated}
              </time>
            ) : null}
            {doc.receivedViaRequestProjectId ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-[var(--panel-hover)] px-1.5 py-0 text-[10px] font-medium text-[var(--muted)] ring-1 ring-[var(--border)]">
                <InboxArrowDownIcon className="h-3 w-3" aria-hidden="true" />
                Received via request
              </span>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** A project hit: folder icon, highlighted name, description and document count. */
export function ProjectResultRow({
  project,
  query,
  index,
  resultIndex,
  tabIndex,
  onFocus,
}: RowProps & { project: SearchProject }) {
  const n = Number.isFinite(project.docCount) ? project.docCount : 0;
  return (
    <li style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * 28}ms` }} className={ROW_ENTER_CLASS}>
      <Link
        href={`/project/${encodeURIComponent(project.id)}`}
        className={ROW_LINK_CLASS}
        data-result-index={resultIndex}
        tabIndex={tabIndex}
        onFocus={() => onFocus(resultIndex)}
      >
        <div className="mt-0.5 grid h-10 w-14 shrink-0 place-items-center rounded-md border border-[var(--border)] bg-[var(--panel-hover)] text-[var(--muted-2)]">
          <FolderIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5 text-[var(--fg)]">
            <Highlight text={project.name || "Untitled project"} query={query} />
          </div>
          {project.description ? (
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-[var(--muted)]">
              <Highlight text={project.description} query={query} />
            </div>
          ) : null}
          <div className="mt-1.5 text-[11px] text-[var(--muted-2)]">
            {n} {n === 1 ? "document" : "documents"}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Placeholder rows shown while the first fetch is in flight. */
export function SearchSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden="true">
      <div className="mb-2 h-3 w-16 rounded bg-[var(--panel-hover)]" />
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
        <ul className="divide-y divide-[var(--border)]">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="h-10 w-14 rounded-md bg-[var(--panel-hover)]" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-[min(420px,70%)] rounded bg-[var(--panel-hover)]" />
                <div className="mt-2 h-3 w-[min(520px,85%)] rounded bg-[var(--panel-hover)]" />
                <div className="mt-2 h-3 w-32 rounded bg-[var(--panel-hover)]" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
