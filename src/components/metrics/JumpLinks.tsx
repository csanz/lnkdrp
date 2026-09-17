/**
 * Chips that jump to the people matrix, the page table and the links table, since on a busy
 * document the links table sits thousands of pixels down. The chip for the section in view is
 * marked active.
 */
"use client";

import { useEffect, useState } from "react";

export type JumpLinksProps = { pages: boolean; links: boolean; className?: string };

function jumpTo(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/** Id of the last listed section whose top has passed the top third of the viewport. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    const list = key.split(",").filter(Boolean);
    const els = list.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null && !el.hidden);
    if (els.length === 0) return;
    const pick = () => {
      const line = window.innerHeight * 0.34;
      let current: string | null = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top <= line) current = el.id;
      }
      setActive(current);
    };
    // The band is the viewport's top third, so a callback fires exactly when a section's top or bottom crosses its lower edge.
    const io = new IntersectionObserver(pick, { rootMargin: "0px 0px -66% 0px" });
    els.forEach((el) => io.observe(el));
    pick();
    return () => io.disconnect();
  }, [key]);
  return active;
}

/** "People · Pages · Links" anchor chips; sections that aren't rendered are left out. */
export default function JumpLinks({ pages, links, className = "" }: JumpLinksProps) {
  const items = [
    { id: "reading", label: "People", show: true },
    { id: "pages", label: "Pages", show: pages },
    { id: "links", label: "Links", show: links },
  ].filter((i) => i.show);
  const active = useActiveSection(items.map((i) => i.id));
  return (
    <nav aria-label="Jump to section" data-jump-links className={`flex gap-2 overflow-x-auto lg:flex-wrap lg:overflow-visible ${className}`}>
      {items.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          onClick={(e) => jumpTo(e, id)}
          aria-current={active === id ? "location" : undefined}
          className={`relative inline-flex h-8 shrink-0 items-center before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] sm:before:hidden whitespace-nowrap rounded-full border px-3 text-xs font-semibold hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] lg:h-7 ${
            active === id
              ? "border-emerald-500/40 bg-emerald-500/10 text-[var(--fg)]"
              : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]"
          }`}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
