/**
 * Who this document is, for the header of one of its sub-pages.
 *
 * The document page's title row is a small identity card — star, name, version, tags, the projects
 * it belongs to — and its Links, Metrics and History pages used to replace all of it with a tile
 * and the word "Document". Clicking Metrics from a document therefore felt like leaving it rather
 * than going deeper into it, which is the whole complaint this answers.
 *
 * So the sub-pages render the same row, from the same data, in the same order, and put the
 * breadcrumb underneath where the document page puts its file facts. Nothing moves on navigation
 * but the second line.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DocumentTextIcon, FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

import StarIcon from "@/components/icons/StarIcon";
import TagsRow from "@/components/tags/TagsRow";
import { rememberEntityTitle, useEntityTitle } from "@/lib/client/entityTitles";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { isDocStarred, STARRED_DOCS_CHANGED_EVENT, toggleStarredDoc } from "@/lib/starredDocs";

type DocProject = { id: string; name: string; isRequest?: boolean };
type DocIdentity = { title: string; version: number | null; projects: DocProject[] };

/** How many project pills before the rest become "+2" — the document page's own rule. */
const MAX_PROJECTS = 2;

export default function DocIdentityRow({ docId, fallbackTitle }: { docId: string; fallbackTitle?: string }) {
  const [doc, setDoc] = useState<DocIdentity | null>(null);
  const [starred, setStarred] = useState(false);
  /** What this browser last knew this document to be called — the name shown on the first frame. */
  const remembered = useEntityTitle("doc", docId);

  // Whatever the page already knew is worth remembering too: a sub-page reached from a list has a
  // fallbackTitle in hand before any fetch, and the next page in should not have to re-learn it.
  useEffect(() => {
    const seed = fallbackTitle?.trim();
    if (seed) rememberEntityTitle("doc", docId, seed);
  }, [docId, fallbackTitle]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}?lite=1`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as {
          doc?: { title?: unknown; lastUpdate?: { version?: unknown } | null; projects?: unknown };
        };
        if (cancelled) return;
        const raw = json.doc ?? {};
        const projects = Array.isArray(raw.projects)
          ? (raw.projects as Array<Record<string, unknown>>).map((p) => ({
              id: String(p.id ?? ""),
              name: typeof p.name === "string" ? p.name : "",
              isRequest: Boolean(p.isRequest),
            }))
          : [];
        const version = raw.lastUpdate && typeof raw.lastUpdate.version === "number" ? raw.lastUpdate.version : null;
        const fetchedTitle = typeof raw.title === "string" ? raw.title : "";
        setDoc({ title: fetchedTitle, version, projects });
        // The server has spoken: correct the remembered name for every page after this one.
        rememberEntityTitle("doc", docId, fetchedTitle);
      } catch {
        // The title the page already knows stands in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  /**
   * Stars go through the store the sidebar reads, never straight to the API.
   *
   * `toggleStarredDoc` writes the local list, posts to the server and fires
   * `STARRED_DOCS_CHANGED_EVENT` — which the sidebar's Starred section listens for, so a star set
   * from a document's Metrics page lands in the list under the cursor. Posting to `/api/starred`
   * from here left the sidebar on its old list until a reload, which looked like nothing
   * happening at all.
   */
  useEffect(() => {
    const sync = () => setStarred(isDocStarred(docId));
    sync();
    window.addEventListener(STARRED_DOCS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(STARRED_DOCS_CHANGED_EVENT, sync);
  }, [docId]);

  const toggleStar = useCallback(() => {
    const next = toggleStarredDoc({ id: docId, title: doc?.title?.trim() || fallbackTitle?.trim() || "" });
    setStarred(next.starred);
  }, [docId, doc?.title, fallbackTitle]);

  /**
   * The name, in order of authority: this row's own fetch, then whatever the page already had,
   * then what this browser last knew the document to be called.
   *
   * There is no "Document" in that list any more. A placeholder shaped like a name is what made
   * every walk into Links or Metrics read as arriving at a different, unnamed document for a beat.
   * When all three are empty the row renders a skeleton — honest about not knowing yet — and that
   * only happens for a document this browser has never seen.
   */
  const title = doc?.title?.trim() || fallbackTitle?.trim() || remembered || "";

  const projects = doc?.projects ?? [];
  const shown = projects.slice(0, MAX_PROJECTS);
  const extra = projects.length - shown.length;

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {/* The document's own glyph, in the slot every other header puts one: `AppPageHeader` draws a
          page's icon here, the project header draws a folder, and a document showed nothing at all.
          Same 20px, same muted colour, so the name starts on the same pixel on every page. */}
      <DocumentTextIcon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />

      {title ? (
        <Link
          href={`/doc/${encodeURIComponent(docId)}`}
          className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--fg)] hover:underline underline-offset-4"
        >
          {title}
        </Link>
      ) : (
        <span
          className="block h-5 w-40 animate-pulse rounded bg-[var(--panel-hover)]"
          aria-label="Loading document name"
        />
      )}

      {/* After the name, not before it: the name is what the page is, and a control in front of it
          pushed the one thing you read into second place. */}
      <button
        type="button"
        onClick={toggleStar}
        aria-label={starred ? "Unstar document" : "Star document"}
        title={starred ? "Starred" : "Star"}
        className={[
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--panel-hover)]",
          starred ? "text-amber-600 dark:text-amber-200" : "text-[var(--muted)] hover:text-[var(--fg)]",
        ].join(" ")}
      >
        <StarIcon filled={starred} />
      </button>

      {doc?.version != null && doc.version > 0 ? (
        <Link
          href={`/doc/${encodeURIComponent(docId)}/history#v-${doc.version}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-2)] transition-colors hover:text-[var(--fg)]"
          title={`Version ${doc.version} (view history)`}
        >
          <span>v{doc.version}</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span>History</span>
        </Link>
      ) : null}

      <TagsRow targetKind="doc" targetId={docId} variant="header" />

      {shown.map((p) => (
        <Link
          key={p.id}
          href={`/project/${encodeURIComponent(p.id)}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 align-middle text-[12px] font-medium leading-none text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
        >
          {p.isRequest ? (
            <InboxArrowDownIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="max-w-[160px] truncate">{p.name}</span>
        </Link>
      ))}
      {extra > 0 ? <span className="shrink-0 text-[12px] font-medium text-[var(--muted-2)]">+{extra}</span> : null}
    </span>
  );
}
