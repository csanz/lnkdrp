/**
 * Client component for `/tag/:slug`.
 *
 * The same header band as every other top-level page, with the tag's own dot where the page icon
 * goes — so a tag page reads as a place in the app rather than a filtered list that happened.
 *
 * Contacts come from `/api/contacts?tagId=` rather than from the items route, because that route
 * applies the plan's identity rule (a contact who never introduced themselves is a domain and a
 * date on Free), and the tag page must not become the one place that rule is skipped.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Cog6ToothIcon, DocumentTextIcon, FolderIcon, TagIcon, UserIcon } from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import TagDot from "@/components/tags/TagDot";
import { rememberEntityTitles } from "@/lib/client/entityTitles";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };
type DocRow = { id: string; title: string; version: number | null; isArchived: boolean; updatedDate: string | null };
type ProjectRow = { id: string; name: string; slug: string; description: string; docCount: number | null };
/** The slice of a `/api/contacts` row this page prints; `name` and `email` are null when the plan withholds them. */
type ContactRow = { id: string; name: string | null; email: string | null; domain: string | null; lastSeenAt: string; documentsRead: number };

/** The tag page lists everything; this is only the route's ceiling, not a page size. */
const CONTACTS_LIMIT = 200;

export default function TagPageClient({ slug }: { slug: string }) {
  const [tag, setTag] = useState<Tag | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTempUser(`/api/tags/by-slug/${encodeURIComponent(slug)}/items`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      const json = (await res.json()) as { tag?: Tag; docs?: DocRow[]; projects?: ProjectRow[] };
      setTag(json.tag ?? null);
      const nextDocs = Array.isArray(json.docs) ? json.docs : [];
      const nextProjects = Array.isArray(json.projects) ? json.projects : [];
      setDocs(nextDocs);
      setProjects(nextProjects);
      // A name this page has already drawn is a name the page you click into should not have to
      // fetch before it can title itself.
      rememberEntityTitles("doc", nextDocs);
      rememberEntityTitles("project", nextProjects);
      setNotFound(false);

      // The people carrying the tag, through the contacts route so the plan's identity rule applies.
      if (json.tag?.id) {
        const qs = new URLSearchParams({ tagId: json.tag.id, limit: String(CONTACTS_LIMIT), sort: "lastSeen", dir: "desc" });
        const people = await fetchWithTempUser(`/api/contacts?${qs.toString()}`, { cache: "no-store" });
        if (people.ok) {
          const body = (await people.json().catch(() => null)) as { items?: ContactRow[] } | null;
          setContacts(Array.isArray(body?.items) ? body!.items! : []);
        }
      }
    } catch {
      // Leaves the empty state below, which says the same thing without an alarm.
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = docs.length + projects.length + contacts.length;
  const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={TagIcon}
        actions={
          <Link
            href="/tags"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
          >
            <Cog6ToothIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            Manage tags
          </Link>
        }
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            {tag ? <TagDot color={tag.color} /> : null}
            {/* The URL slug is not the tag's name — it is lower-cased and hyphenated — so printing
                it here titled the page with something nobody typed, and then corrected itself. A
                header waits instead; only a tag that is genuinely gone gets words. */}
            {tag?.name ? (
              <span className="truncate">{tag.name}</span>
            ) : notFound ? (
              <span className="truncate">Tag not found</span>
            ) : (
              <span
                className="block h-5 w-40 animate-pulse rounded bg-[var(--panel-hover)]"
                aria-label="Loading tag name"
              />
            )}
          </span>
        }
        description={
          notFound
            ? "No tag by that name in this workspace. It may have been renamed or removed."
            : loading
              ? "Everything carrying this tag."
              : total === 0
                ? "Nothing carries this tag yet. Add it from any document, project or contact."
                : `${countOf(total, "item", "items")}: ${countOf(projects.length, "project", "projects")}, ${countOf(docs.length, "document", "documents")}, ${countOf(contacts.length, "contact", "contacts")}.`
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`py-6 ${APP_PAGE_GUTTER}`}>
          {projects.length ? (
            <section className="mb-8">
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                Projects
              </h2>
              <ul className="grid gap-2">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/project/${encodeURIComponent(p.id)}`}
                      className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 transition-colors hover:bg-[var(--panel-hover)]"
                    >
                      <FolderIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--fg)]">{p.name}</span>
                        {p.description ? (
                          <span className="block truncate text-[12px] text-[var(--muted)]">{p.description}</span>
                        ) : null}
                      </span>
                      {typeof p.docCount === "number" ? (
                        <span className="shrink-0 text-xs text-[var(--muted-2)]">
                          {p.docCount} {p.docCount === 1 ? "doc" : "docs"}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {docs.length ? (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                Documents
              </h2>
              <ul className="grid gap-2">
                {docs.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/doc/${encodeURIComponent(d.id)}`}
                      className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 transition-colors hover:bg-[var(--panel-hover)]"
                    >
                      <DocumentTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--fg)]">{d.title}</span>
                      {d.isArchived ? (
                        <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-2)]">
                          Archived
                        </span>
                      ) : null}
                      {d.version != null ? (
                        <span className="shrink-0 text-[11px] text-[var(--muted-2)]">v{d.version}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {contacts.length ? (
            <section className={docs.length || projects.length ? "mt-8" : ""}>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                Contacts
              </h2>
              <ul className="grid gap-2">
                {contacts.map((c) => {
                  // Free withholds the name and address of anyone who did not introduce themselves;
                  // the row then reads as the product does everywhere else: someone, at a domain.
                  const label = c.name?.trim() || c.email?.trim() || "Someone";
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/contacts/${encodeURIComponent(c.id)}`}
                        className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 transition-colors hover:bg-[var(--panel-hover)]"
                      >
                        <UserIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--fg)]">{label}</span>
                          {c.domain && c.domain !== label ? (
                            <span className="block truncate text-[12px] text-[var(--muted)]">{c.domain}</span>
                          ) : null}
                        </span>
                        {typeof c.documentsRead === "number" ? (
                          <span className="shrink-0 text-xs text-[var(--muted-2)]">
                            {c.documentsRead} {c.documentsRead === 1 ? "doc" : "docs"}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {!loading && !notFound && total === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">
              Nothing carries this tag yet. Open a document, a project or a contact and add it from the Tags row.
            </div>
          ) : null}
        </div>
      </div>

    </div>
  );
}
