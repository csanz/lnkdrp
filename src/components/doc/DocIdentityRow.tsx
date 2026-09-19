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
import { FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

import StarIcon from "@/components/icons/StarIcon";
import TagsRow from "@/components/tags/TagsRow";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type DocProject = { id: string; name: string; isRequest?: boolean };
type DocIdentity = { title: string; version: number | null; projects: DocProject[] };

/** How many project pills before the rest become "+2" — the document page's own rule. */
const MAX_PROJECTS = 2;

export default function DocIdentityRow({ docId, fallbackTitle }: { docId: string; fallbackTitle?: string }) {
  const [doc, setDoc] = useState<DocIdentity | null>(null);
  const [starred, setStarred] = useState(false);
  const [starBusy, setStarBusy] = useState(false);

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
        setDoc({ title: typeof raw.title === "string" ? raw.title : "", version, projects });
      } catch {
        // The title the page already knows stands in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // The star is part of the row's shape as much as its meaning: without it the title would sit a
  // few pixels left of where the document page puts it, which is the thing this component exists
  // to prevent.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTempUser("/api/starred", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { docs?: Array<{ id?: unknown }> };
        if (cancelled) return;
        setStarred((json.docs ?? []).some((d) => String(d?.id ?? "") === docId));
      } catch {
        // Unstarred is the safe assumption; the document page is where stars are usually set.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const toggleStar = useCallback(async () => {
    if (starBusy) return;
    setStarBusy(true);
    const next = !starred;
    setStarred(next);
    try {
      const res = await fetchWithTempUser("/api/starred", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docId, starred: next }),
      });
      if (!res.ok) setStarred(!next);
    } catch {
      setStarred(!next);
    } finally {
      setStarBusy(false);
    }
  }, [docId, starBusy, starred]);

  const title = doc?.title?.trim() || fallbackTitle?.trim() || "Document";
  const projects = doc?.projects ?? [];
  const shown = projects.slice(0, MAX_PROJECTS);
  const extra = projects.length - shown.length;

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <button
        type="button"
        onClick={() => void toggleStar()}
        disabled={starBusy}
        aria-label={starred ? "Unstar document" : "Star document"}
        title={starred ? "Starred" : "Star"}
        className={[
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--panel-hover)]",
          starred ? "text-amber-600 dark:text-amber-200" : "text-[var(--muted)] hover:text-[var(--fg)]",
        ].join(" ")}
      >
        <StarIcon filled={starred} />
      </button>

      <Link
        href={`/doc/${encodeURIComponent(docId)}`}
        className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--fg)] hover:underline underline-offset-4"
      >
        {title}
      </Link>

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
