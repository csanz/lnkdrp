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
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import TagDot from "@/components/tags/TagDot";
import IconButton from "@/components/ui/IconButton";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagColorKey } from "@/lib/tags/palette";

type Tag = { id: string; name: string; slug: string; color: TagColorKey; count?: number };

const COLLAPSED_KEY = "ld_sidebar_tags_collapsed";

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
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      // Collapsed unless this browser said otherwise; a tag page opens it regardless.
      if (raw === "0") setCollapsed(false);
    } catch {
      // Storage refused: the default stands.
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

  // A tag added or removed anywhere in the app should show up here without a reload.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("lnkdrp:tags-changed", onChanged);
    return () => window.removeEventListener("lnkdrp:tags-changed", onChanged);
  }, [load]);

  // Nothing at all until there is a tag: an empty section is a permanent question nobody asked.
  if (!tags || !tags.length) return null;

  const open = onTagPage || !collapsed;
  const activeSlug = onTagPage ? decodeURIComponent(pathname.slice("/tag/".length)).toLowerCase() : "";

  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
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
          {/* The count belongs in the header, since the list it counts is usually shut. */}
          <span className="font-semibold text-[var(--muted-2)]/70">{tags.length}</span>
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
    </section>
  );
}
