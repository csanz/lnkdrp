/**
 * The right-hand cluster of a project's header band: the document count, the Links and Metrics
 * buttons, and the settings gear — in that order, at that width, on the project page and on both
 * of its sub-pages.
 *
 * It is one component for one reason: when each page assembled its own cluster, the icons moved.
 * The project page showed "3 docs" and a gear that the links page did not, and the links page
 * added a "New link" button the project page did not, so walking between them slid the same two
 * icons left and right under the cursor. Anything a single page needs and the others do not (the
 * links page's "New link") belongs in that page's body, not in this row.
 *
 * The count keeps its box even before it is known, so the icons do not shift when the number
 * arrives a moment after the page does. When a page cannot supply the count, this fetches it.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChartBarIcon, Cog6ToothIcon, LinkIcon } from "@heroicons/react/24/outline";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

export type ProjectHeaderPage = "project" | "links" | "metrics";

/**
 * One 32px icon button. `active` is the page you are already on, filled so it is unmistakable —
 * a slightly darker background was invisible on the dark theme, which is where this is read.
 */
function ActionButton({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={[
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
        active
          ? "border-transparent bg-[var(--fg)] text-[var(--bg)]"
          : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

export default function ProjectHeaderActions({
  projectSlug,
  current,
  docCount,
  countLabel,
  onSettings,
}: {
  projectSlug: string;
  current: ProjectHeaderPage;
  /** The project's document count. `undefined` means "fetch it"; `null` means "not known yet". */
  docCount?: number | null;
  /** Overrides the count text (the project page says "N archived" while showing the archive). */
  countLabel?: string;
  /**
   * Opens the settings modal, on the page that owns it. The sub-pages have no modal to open, so
   * they omit this and the gear becomes a link to the project page with `?settings=1`, which opens
   * it there — the gear stays in place either way.
   */
  onSettings?: () => void;
}) {
  const [fetched, setFetched] = useState<number | null>(null);
  const shouldFetch = docCount === undefined;

  useEffect(() => {
    if (!shouldFetch) return;
    let cancelled = false;
    void (async () => {
      try {
        // `limit=1` keeps this to one document row: the header only wants `total`.
        const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectSlug)}/docs?limit=1`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { total?: unknown } | null;
        if (!cancelled && typeof json?.total === "number") setFetched(json.total);
      } catch {
        // The box stays empty; the icons stay where they are.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, shouldFetch]);

  const count = shouldFetch ? fetched : docCount ?? null;
  const text = countLabel ?? (count === null ? "" : `${count} ${count === 1 ? "doc" : "docs"}`);
  const base = `/project/${encodeURIComponent(projectSlug)}`;

  return (
    <div className="flex items-center gap-2">
      {/* Holds its width while the number loads, so nothing to its right moves. */}
      <span className="min-w-[44px] text-right text-xs text-[var(--muted-2)]">{text}</span>

      <ActionButton href={`${base}/links`} label="Links" active={current === "links"}>
        <LinkIcon className="h-4 w-4" aria-hidden="true" />
      </ActionButton>
      <ActionButton href={`${base}/metrics`} label="Metrics" active={current === "metrics"}>
        <ChartBarIcon className="h-4 w-4" aria-hidden="true" />
      </ActionButton>

      {onSettings ? (
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Project settings"
          title="Project settings"
          onClick={onSettings}
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </button>
      ) : (
        <Link
          href={`${base}?settings=1`}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted-2)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Project settings"
          title="Project settings"
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
