/**
 * The right-hand cluster of a document's header band: Links, Metrics, and the "…" menu — in that
 * order, at that width, on the document page and on both of its sub-pages.
 *
 * Same rule as the project's cluster (`src/components/project/ProjectHeaderActions.tsx`): the row
 * is right-aligned, so anything a single page adds (a status pill, "Replace file") goes *before*
 * this component and pushes leftwards, never through it. The three controls here are what stays
 * anchored to the right edge, so walking between the document and its sub-pages never slides them.
 *
 * The page you are on is filled rather than tinted, which is the only treatment that reads on the
 * dark theme.
 */
"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ChartBarIcon, LinkIcon } from "@heroicons/react/24/outline";

import DocActionsMenu from "@/components/DocActionsMenu";

export type DocHeaderPage = "doc" | "links" | "metrics";

export default function DocHeaderActions({
  docId,
  current,
  ready = true,
  menu,
}: {
  docId: string;
  current: DocHeaderPage;
  /** A document that is still preparing has no links and no numbers yet. */
  ready?: boolean;
  /**
   * The document page passes its own fully-wired `DocActionsMenu` (it owns the document's state
   * and the handlers that patch it). The sub-pages have neither, so they get the menu below, with
   * the project actions left out rather than guessing at a membership they did not load.
   */
  menu?: ReactNode;
}) {
  const router = useRouter();
  const base = `/doc/${encodeURIComponent(docId)}`;

  const button = (href: string, label: string, active: boolean, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => router.push(href)}
      disabled={!ready}
      aria-disabled={!ready}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={ready ? label : "Available when ready"}
      className={[
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
        active
          ? "border-transparent bg-[var(--fg)] text-[var(--bg)]"
          : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
        ready ? "" : "cursor-not-allowed opacity-60",
      ].join(" ")}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex items-center gap-2 md:gap-3">
      {button(`${base}/links`, "Links", current === "links", <LinkIcon className="h-4 w-4" aria-hidden="true" />)}
      {button(`${base}/metrics`, "Metrics", current === "metrics", <ChartBarIcon className="h-4 w-4" aria-hidden="true" />)}
      {menu ?? <DocActionsMenu docId={docId} showRemoveFromProject={false} onDeleted={() => router.push("/")} />}
    </div>
  );
}
