/**
 * Client component for `/contacts`.
 *
 * The same header band as Activity and Tags, with the controls a list of people needs: search,
 * a sort with its direction, and three filters (tag, how they arrived, domain). Every control is
 * mirrored into the URL bar so a filtered view survives a reload and can be sent to a teammate,
 * and the same query feeds "Download CSV", so the file is the rows on screen.
 *
 * Identity follows the plan. On Free the API blanks name and email for anyone who did not
 * introduce themselves; those rows show the domain and a Pro hint, and a banner above the table
 * says why, so the blanks read as a plan and not as a bug.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowDownTrayIcon,
  ArrowUpIcon,
  CheckBadgeIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import Button from "@/components/ui/Button";
import DataTable from "@/components/ui/DataTable";
import TagDot from "@/components/tags/TagDot";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { formatRelative } from "@/components/connect/format";
import { useSkeletonDelay } from "@/lib/client/useSkeletonDelay";
import {
  CONTACT_SORTS,
  CONTACT_SOURCE_KINDS,
  CONTACT_SOURCE_LABELS,
  DEFAULT_CONTACT_QUERY,
  contactsExportHref,
  contactsQueryFromSearch,
  contactsUrlQuery,
  isContactSort,
  isContactSourceKind,
  useContacts,
  type ContactListQuery,
  type ContactRow,
} from "@/lib/client/useContacts";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagDTO } from "@/lib/tags/service";

/** How many tag chips a row shows before the rest become "+N". */
const ROW_TAGS_VISIBLE = 3;

/** How long the search box waits after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 250;

const FIELD_CLASS =
  "h-8 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)]";

/** The empty-state copy. Word for word from the PRD, so help and product say the same thing. */
const EMPTY_COPY = "No contacts yet. People appear here the first time they introduce themselves, sign in to read, or ask to download.";

function ProHint({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Who this is shows on Pro"
      className="ml-1.5 rounded px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--muted-2)] ring-1 ring-[var(--border)] hover:text-[var(--fg)]"
    >
      Pro
    </button>
  );
}

function RowTags({ tags }: { tags: TagDTO[] }) {
  if (!tags.length) return <span className="text-[var(--muted-2)]">–</span>;
  const shown = tags.slice(0, ROW_TAGS_VISIBLE);
  const extra = tags.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={tags.map((t) => t.name).join(", ")}>
      {shown.map((tag) => (
        <Link
          key={tag.id}
          href={`/tag/${encodeURIComponent(tag.slug)}`}
          className="inline-flex h-6 max-w-[140px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 text-[11px] font-medium text-[var(--muted)] hover:text-[var(--fg)]"
        >
          <TagDot color={tag.color} size={6} />
          <span className="truncate">{tag.name}</span>
        </Link>
      ))}
      {extra > 0 ? <span className="text-[11px] text-[var(--muted-2)]">+{extra}</span> : null}
    </span>
  );
}

function ContactName({ contact, onPro }: { contact: ContactRow; onPro: () => void }) {
  const redacted = !contact.name && !contact.email;
  const href = `/contacts/${encodeURIComponent(contact.id)}`;
  if (redacted) {
    return (
      <span className="inline-flex min-w-0 items-center">
        <Link href={href} className="font-medium text-[var(--fg)] hover:underline">
          Someone
        </Link>
        {contact.domain ? <span className="ml-1.5 truncate text-[var(--muted)]">at {contact.domain}</span> : null}
        <ProHint onClick={onPro} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Link href={href} className="truncate font-medium text-[var(--fg)] hover:underline">
          {contact.name || contact.email}
        </Link>
        {contact.verified ? (
          <CheckBadgeIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-label="Verified address" />
        ) : null}
      </span>
      {contact.name && contact.email ? <span className="truncate text-[12px] text-[var(--muted)]">{contact.email}</span> : null}
    </span>
  );
}

export default function ContactsPageClient() {
  /** `null` until the URL bar has been read, so the first request is the one the URL asked for. */
  const [query, setQuery] = useState<ContactListQuery | null>(null);
  const [search, setSearch] = useState("");
  const [domainInput, setDomainInput] = useState("");
  const [tags, setTags] = useState<TagDTO[]>([]);
  const { openUpgrade } = useUpgradeModal();

  useEffect(() => {
    const initial = contactsQueryFromSearch(window.location.search);
    setQuery(initial);
    setSearch(initial.q);
    setDomainInput(initial.domain);
  }, []);

  // The filters in the URL bar, replaced in place so Back still leaves the page rather than
  // stepping through every keystroke.
  useEffect(() => {
    if (!query) return;
    const url = new URL(window.location.href);
    url.search = contactsUrlQuery(query);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [query]);

  // Search and the domain box are typed; the query takes them after a pause.
  useEffect(() => {
    if (!query) return;
    const q = search.trim();
    const domain = domainInput.trim();
    if (q === query.q.trim() && domain === query.domain.trim()) return;
    const t = window.setTimeout(() => {
      setQuery((prev) => (prev ? { ...prev, q, domain, page: 1 } : prev));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search, domainInput, query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTempUser("/api/tags", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { tags?: TagDTO[] };
        if (!cancelled && Array.isArray(json.tags)) setTags(json.tags);
      } catch {
        // The tag filter is a convenience; the list stands without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { data, loading, pending, error } = useContacts(query);
  const showSkeleton = useSkeletonDelay(loading && !data);

  const update = (patch: Partial<ContactListQuery>) => setQuery((prev) => (prev ? { ...prev, ...patch, page: 1 } : prev));

  const effective = query ?? DEFAULT_CONTACT_QUERY;
  const filtered = Boolean(effective.q.trim() || effective.tagId || effective.source || effective.domain.trim());
  const total = data?.total ?? 0;
  const pageSize = data?.limit ?? 50;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(effective.page, pageCount);
  const identity = data ? data.identity : true;

  const exportHref = useMemo(() => contactsExportHref(effective), [effective]);

  const clearFilters = () => {
    setSearch("");
    setDomainInput("");
    update({ q: "", tagId: "", source: "", domain: "" });
  };

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={UsersIcon}
        title="Contacts"
        description="Everyone this workspace has heard from: who introduced themselves, signed in to read, asked to download, or uploaded to a request."
        actions={
          <a
            href={exportHref}
            download
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
          >
            <ArrowDownTrayIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            Download CSV
          </a>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={total > 0 && !filtered ? `Search ${total} contacts` : "Search name, email or domain"}
            aria-label="Search contacts"
            className={`${FIELD_CLASS} w-full sm:w-64`}
          />

          <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">Sort</span>
            <select
              value={effective.sort}
              aria-label="Sort contacts"
              className={FIELD_CLASS}
              onChange={(e) => {
                const next = e.target.value;
                if (!isContactSort(next)) return;
                const def = CONTACT_SORTS.find((s) => s.id === next)?.defaultDir ?? "desc";
                update({ sort: next, dir: def });
              }}
            >
              {CONTACT_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => update({ dir: effective.dir === "asc" ? "desc" : "asc" })}
              aria-label={effective.dir === "asc" ? "Sorted ascending. Switch to descending" : "Sorted descending. Switch to ascending"}
              title={effective.dir === "asc" ? "Ascending" : "Descending"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
            >
              {effective.dir === "asc" ? <ArrowUpIcon className="h-4 w-4" /> : <ArrowDownIcon className="h-4 w-4" />}
            </button>
          </label>

          <div aria-hidden="true" className="hidden h-6 w-px bg-[var(--border)] sm:block" />

          <select
            value={effective.tagId}
            aria-label="Filter by tag"
            className={FIELD_CLASS}
            onChange={(e) => update({ tagId: e.target.value })}
          >
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <select
            value={effective.source}
            aria-label="Filter by how they arrived"
            className={FIELD_CLASS}
            onChange={(e) => {
              const next = e.target.value;
              update({ source: isContactSourceKind(next) ? next : "" });
            }}
          >
            <option value="">Any source</option>
            {CONTACT_SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {CONTACT_SOURCE_LABELS[k]}
              </option>
            ))}
          </select>

          <input
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="Domain"
            aria-label="Filter by domain"
            className={`${FIELD_CLASS} w-40`}
          />

          {filtered ? (
            <button
              type="button"
              onClick={clearFilters}
              className="h-8 rounded-lg px-2 text-[13px] font-medium text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Clear
            </button>
          ) : null}
        </div>
      </AppPageHeader>

      <div className={`relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={pending || loading}>
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-8 -mt-6 mb-4 h-0.5 overflow-hidden bg-transparent">
            <div className="h-full w-1/3 bg-[var(--fg)]/60 motion-safe:animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
          </div>
        ) : null}

        {error ? (
          <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">{error}</div>
        ) : null}

        {data && !identity ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--panel)] px-4 py-3">
            <p className="text-sm text-[var(--fg)]">Free shows who introduced themselves. Upgrade to Pro to see everyone who read.</p>
            <div className="flex items-center gap-3">
              <Button variant="solid" size="sm" onClick={() => openUpgrade("analytics_history", { from: "contacts" })}>
                Upgrade to Pro
              </Button>
              <Link
                href="/pricing?from=contacts"
                className="text-xs font-medium text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
              >
                See what is included
              </Link>
            </div>
          </div>
        ) : null}

        {showSkeleton ? (
          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]" aria-hidden="true">
            <ul className="divide-y divide-[var(--border)]">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="flex items-center gap-4 px-4 py-3">
                  <span className="h-4 w-40 animate-pulse rounded bg-[var(--panel-hover)]" />
                  <span className="h-4 w-24 animate-pulse rounded bg-[var(--panel-hover)]" />
                  <span className="ml-auto h-4 w-16 animate-pulse rounded bg-[var(--panel-hover)]" />
                </li>
              ))}
            </ul>
          </div>
        ) : data && data.items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">
            {filtered ? (
              <>
                <div className="text-[15px] font-medium text-[var(--fg)]">No contacts match.</div>
                <p className="mx-auto mt-1 max-w-md">Try a shorter search, or clear the filters.</p>
                <div className="mt-4">
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              </>
            ) : (
              <p className="mx-auto max-w-md">{EMPTY_COPY}</p>
            )}
          </div>
        ) : data ? (
          <>
            <DataTable>
              <thead className="bg-[var(--panel-2)] text-[12px] font-semibold text-[var(--muted-2)]">
                <tr>
                  <th className="px-3 py-2 pl-4 font-semibold">Name</th>
                  <th className="whitespace-nowrap px-3 py-2 font-semibold">Domain</th>
                  <th className="px-3 py-2 font-semibold">Tags</th>
                  <th className="whitespace-nowrap px-3 py-2 font-semibold">Last seen</th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Documents read</th>
                  <th className="whitespace-nowrap px-3 py-2 pr-4 text-right font-semibold">Visits</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="border-t border-[var(--divider)] hover:bg-[var(--panel-hover)]">
                    <td className="max-w-[320px] px-3 py-2 pl-4">
                      <ContactName contact={c} onPro={() => openUpgrade("analytics_history", { from: "contacts" })} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">{c.domain ?? "–"}</td>
                    <td className="px-3 py-2">
                      <RowTags tags={c.tags} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]" title={c.lastSeenAt}>
                      {formatRelative(c.lastSeenAt) || "–"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[var(--fg)]">{c.documentsRead}</td>
                    <td className="whitespace-nowrap px-3 py-2 pr-4 text-right tabular-nums text-[var(--fg)]">{c.visits}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            {pageCount > 1 ? (
              <div className="mt-4 flex items-center justify-between gap-3 text-[13px]">
                <span className="text-[var(--muted)]">
                  {(current - 1) * pageSize + 1}–{Math.min(current * pageSize, total)} of {total}
                  {filtered ? " matching" : ""}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={current <= 1}
                    onClick={() => setQuery((prev) => (prev ? { ...prev, page: current - 1 } : prev))}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--fg)] disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-[var(--muted)]">
                    {current} / {pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={current >= pageCount}
                    onClick={() => setQuery((prev) => (prev ? { ...prev, page: current + 1 } : prev))}
                    className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--fg)] disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
