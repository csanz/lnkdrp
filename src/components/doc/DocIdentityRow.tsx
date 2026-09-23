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
 *
 * The row's own read of the document lives in `entityIdentity` rather than here, so the breadcrumb
 * beside it and the sub-page around it share the one request instead of each issuing their own.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DocumentTextIcon, FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

import StarIcon from "@/components/icons/StarIcon";
import TagsRow from "@/components/tags/TagsRow";
import { EntityHeaderName, useHeaderName } from "@/components/HeaderIdentity";
import { useEntityIdentity } from "@/lib/client/entityIdentity";
import { rememberEntityTitle } from "@/lib/client/entityTitles";
import { isDocStarred, STARRED_DOCS_CHANGED_EVENT, toggleStarredDoc } from "@/lib/starredDocs";

/** How many project pills before the rest become "+2" — the document page's own rule. */
const MAX_PROJECTS = 2;

/** Render the document's identity row: glyph, name, star, version, tags and project pills. */
export default function DocIdentityRow({ docId, fallbackTitle }: { docId: string; fallbackTitle?: string }) {
  const [starred, setStarred] = useState(false);
  const { identity } = useEntityIdentity("doc", docId);
  /**
   * The name, in order of authority: whatever the page already had, then this session's read of the
   * document, then what this browser last knew it to be called.
   *
   * There is no "Document" in that list. A placeholder shaped like a name is what made every walk
   * into Links or Metrics read as arriving at a different, unnamed document for a beat.
   */
  const { name: title } = useHeaderName("doc", docId, fallbackTitle);

  // Whatever the page already knew is worth remembering too: a sub-page reached from a list has a
  // fallbackTitle in hand before any fetch, and the next page in should not have to re-learn it.
  useEffect(() => {
    const seed = fallbackTitle?.trim();
    if (seed) rememberEntityTitle("doc", docId, seed);
  }, [docId, fallbackTitle]);

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
    // Without a name there is nothing safe to write: `toggleStarredDoc` substitutes the literal
    // "Document" for an empty title and POSTs it to /api/starred, which persists that placeholder
    // as the document's name on every device — and `entityTitles` then recalls it as the
    // remembered name, painting "Document" as the title on every later navigation. The button is
    // disabled for the few hundred milliseconds the name is unknown instead.
    if (!title) return;
    const next = toggleStarredDoc({ id: docId, title });
    setStarred(next.starred);
  }, [docId, title]);

  const projects = identity?.projects ?? [];
  const shown = projects.slice(0, MAX_PROJECTS);
  const extra = projects.length - shown.length;
  const version = identity?.version ?? null;

  return (
    /* `flex-wrap`, as the document page's own header already does (pageClient.tsx:2278). On a doc
       sub-page the action cluster takes ~235px of a 390px row, leaving ~99px here — the name
       collapsed to an ellipsis and everything after it (the star, the version/History link, tags,
       project pills) was cut off with no way to reach it. Wrapping puts them on a second line
       instead of off the edge. */
    <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      {/* The document's own glyph, in the slot every other header puts one: `AppPageHeader` draws a
          page's icon here, the project header draws a folder, and a document showed nothing at all.
          Same 20px, same muted colour, so the name starts on the same pixel on every page. */}
      <DocumentTextIcon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />

      {/* Unknown draws a skeleton — honest about not knowing yet — and only until the read settles,
          because a pulse that never resolves is worse than a plain word. */}
      <EntityHeaderName kind="doc" id={docId} name={fallbackTitle} href={`/doc/${encodeURIComponent(docId)}`} />

      {/* After the name, not before it: the name is what the page is, and a control in front of it
          pushed the one thing you read into second place. */}
      <button
        type="button"
        onClick={toggleStar}
        disabled={!title}
        aria-disabled={!title}
        aria-label={starred ? "Unstar document" : "Star document"}
        title={!title ? "Loading document name…" : starred ? "Starred" : "Star"}
        className={[
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--panel-hover)]",
          starred ? "text-amber-600 dark:text-amber-200" : "text-[var(--muted)] hover:text-[var(--fg)]",
          !title ? "cursor-not-allowed opacity-50 hover:bg-transparent" : "",
        ].join(" ")}
      >
        <StarIcon filled={starred} />
      </button>

      {version != null && version > 0 ? (
        <Link
          href={`/doc/${encodeURIComponent(docId)}/history#v-${version}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-2)] transition-colors hover:text-[var(--fg)]"
          title={`Version ${version} (view history)`}
        >
          <span>v{version}</span>
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
