/**
 * The sidebar's Tags section: every tag in the workspace, with how many things carry it.
 *
 * Collapsed by default (2026-09-18 decision). Tags are a filing system, not a navigation spine —
 * a workspace with twenty of them would otherwise push Projects off the screen for everyone who
 * never uses them. It opens itself when you are looking at a tag page, so arriving there from a
 * chip does not leave the section that explains where you are shut.
 *
 * Dots, not pills: at 6px in a dense list, a colour is a hint, and the name does the work.
 */
"use client";

import Link from "next/link";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import TagDot from "@/components/tags/TagDot";
import TagsManagerModal from "@/components/modals/TagsManagerModal";
import IconButton from "@/components/ui/IconButton";
import { subscribeRealtime } from "@/lib/client/realtime";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };

/**
 * Closed by default, and nothing is remembered between loads.
 *
 * It opened itself for a while, because a header with a count and nothing under it read as a
 * feature that was not working. What actually fixed that is the dots on the rows: the sidebar now
 * says which project is fundraising without this list being open at all, so the list can go back
 * to being what it was asked to be — somewhere to go, not something to read.
 *
 * Nothing persists on purpose. Two earlier versions stored the open state, and both times a stale
 * "closed" written under an older default outlived the rule that wrote it and pinned the section
 * shut — twice reported as "the tags don't show up". Per visit is simpler and cannot rot.
 */

/** The same plus/minus the other sidebar sections use, without importing the sidebar itself. */
function PlusMinus({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {expanded ? null : <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

export default function SidebarTagsSection() {
  const pathname = usePathname() ?? "";
  const onTagPage = pathname.startsWith("/tag/");
  const [tags, setTags] = useState<Tag[] | null>(null);
  /** `null` until you say otherwise in this visit; the default depends on how many tags there are. */
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(null);
  const [managing, setManaging] = useState(false);

  // The retired keys are cleared so nothing written by the older defaults can reach this again.
  useEffect(() => {
    try {
      window.localStorage.removeItem("ld_sidebar_tags_collapsed");
      window.localStorage.removeItem("ld_sidebar_tags_open");
    } catch {
      // ignore
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTempUser("/api/tags", { cache: "no-store" });
      if (!res.ok) {
        setTags([]);
        return;
      }
      const json = (await res.json()) as { tags?: Tag[] };
      setTags(Array.isArray(json.tags) ? json.tags : []);
    } catch {
      setTags([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A tag added or removed anywhere in the app shows up here at once — and the section opens to
   * show it.
   *
   * Refreshing a collapsed list is refreshing nothing anyone can see: tagging a project put
   * "Fundraising 1" into a list that was shut, so the change looked like it had not happened. The
   * open state is not written to storage here, so the section is still collapsed by default the
   * next time the app loads; this is only "you just did something, here it is".
   */
  useEffect(() => {
    // Not opened for you: the row you just tagged shows its own dot, which is the answer to "did
    // that work" without a section unfolding under your cursor.
    const onChanged = () => void load();
    window.addEventListener("lnkdrp:tags-changed", onChanged);
    return () => window.removeEventListener("lnkdrp:tags-changed", onChanged);
  }, [load]);

  /**
   * Someone else's change — a teammate, or an agent filing documents through the MCP — arrives on
   * the workspace's realtime feed, which carries every activity row. Tagging writes `tag.applied`
   * and `tag.removed`, so the list updates while you watch it rather than on your next navigation.
   * Focus is kept as the fallback for a socket that is down or unavailable.
   */
  useEffect(() => {
    const unsubscribe = subscribeRealtime("activity", (frame) => {
      const type = frame.type === "activity" ? (frame.event?.type ?? "") : "";
      if (type.startsWith("tag.")) void load();
    });
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  useEffect(() => {
    void load();
  }, [pathname, load]);

  // "Manage tags" from anywhere in the app (the picker's footer) opens the same modal here.
  useEffect(() => {
    const onManage = () => setManaging(true);
    window.addEventListener("lnkdrp:manage-tags", onManage);
    return () => window.removeEventListener("lnkdrp:manage-tags", onManage);
  }, []);

  // Nothing at all until there is a tag: an empty section is a permanent question nobody asked.
  if (!tags || !tags.length) return null;

  // Open only when you opened it, or when you are on a tag page — where the list is the context.
  const open = onTagPage || collapsedPref === false;
  const activeSlug = onTagPage ? decodeURIComponent(pathname.slice("/tag/".length)).toLowerCase() : "";

  function toggle() {
    setCollapsedPref(open);
  }

  return (
    <section>
      <div className="group flex h-7 items-center gap-1 pl-2 pr-2 text-[11px] font-semibold uppercase leading-5 tracking-[0.08em] text-[var(--muted-2)]">
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-1 py-0 text-left hover:bg-[var(--sidebar-hover)]"
          onClick={toggle}
        >
          <span>Tags</span>
          {/* The count stays in the header for when the list is closed. */}
          <span className="font-semibold text-[var(--muted-2)]/70">{tags.length}</span>
        </button>
        {/* Rename, recolour, merge, delete — in a modal, like Starred's and Projects' full lists,
            so tidying a tag never costs you the page you were on. Always visible, not revealed on
            hover: this section is collapsed by default, so a hidden control meant the answer to
            "where do I manage tags" was nowhere on the screen. */}
        <button
          type="button"
          aria-label="Manage tags"
          title="Manage tags"
          onClick={() => setManaging(true)}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-2)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]"
        >
          <Cog6ToothIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <IconButton
          ariaLabel={open ? "Collapse tags" : "Expand tags"}
          variant="ghost"
          size="sm"
          className="h-6 w-6 rounded-md p-0 text-[var(--muted-2)] hover:text-[var(--fg)]"
          onClick={toggle}
        >
          <PlusMinus expanded={open} />
        </IconButton>
      </div>

      {open ? (
        <ul className="mt-0.5 grid gap-0.5">
          {tags.map((tag) => {
            const active = activeSlug === tag.slug;
            return (
              <li key={tag.id} className="min-w-0">
                <Link
                  href={`/tag/${encodeURIComponent(tag.slug)}`}
                  className={[
                    "flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                    active
                      ? "bg-[var(--sidebar-hover)] font-medium text-[var(--fg)]"
                      : "text-[var(--muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--fg)]",
                  ].join(" ")}
                  title={typeof tag.count === "number" ? `${tag.name} · ${tag.count}` : tag.name}
                >
                  <TagDot color={tag.color} size={6} />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  {typeof tag.count === "number" && tag.count > 0 ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted-2)]">{tag.count}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}

      <TagsManagerModal open={managing} onClose={() => setManaging(false)} />
    </section>
  );
}
