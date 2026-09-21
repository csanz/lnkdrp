"use client";

/**
 * OverflowMenu — a trigger button that opens a portal-positioned panel holding whatever a toolbar
 * had no room for.
 *
 * Built out of the row-menu pattern in `LinksManager.tsx` (portal + fixed positioning + a
 * click-away/Escape lifecycle), generalized: that one renders a fixed list of `{label, onSelect}`
 * rows, this one renders the caller's own `children` — a toggle group, a row of zoom buttons,
 * whatever the toolbar's mobile menu needs to hold, sharing state and handlers with the desktop
 * controls rather than a second copy of the logic. Portal + `position: fixed` on purpose: a
 * toolbar collapsed enough to need this is usually inside a `overflow-hidden` shell (so it doesn't
 * bleed under content while animating), which would clip an in-flow dropdown.
 *
 * Content-agnostic and unstyled beyond layout, so a caller on the app's light/dark `var(--panel)`
 * tokens and a caller on a fixed dark viewer chrome (`bg-black`, `border-white/10`) both look like
 * their own surface, not a foreign popover — pass `panelClassName` for the panel's own surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DEFAULT_PANEL_WIDTH = 240;

export default function OverflowMenu({
  label,
  trigger,
  triggerClassName,
  panelClassName,
  panelWidth = DEFAULT_PANEL_WIDTH,
  align = "end",
  autoFocus = false,
  panelRole = "menu",
  children,
}: {
  /** Accessible name for the trigger button and the panel (`aria-label` on both). */
  label: string;
  /** Trigger button's own content (usually an icon); defaults to a hamburger glyph. */
  trigger?: React.ReactNode;
  triggerClassName?: string;
  /** Panel surface classes (background, border, radius, shadow) — layout classes are fixed. */
  panelClassName?: string;
  /** Panel width in px, used to keep it on-screen; default fits a short menu of toolbar controls. */
  panelWidth?: number;
  /** Which edge of the trigger the panel's own edge lines up with. */
  align?: "start" | "end";
  /**
   * Move focus into the panel when it opens, and back to the trigger when it closes.
   *
   * Off by default, and deliberately so: the toolbar callers this was built for hold mixed content
   * (toggle groups, sliders) where "focus the first thing" is usually the wrong thing. A panel of
   * uniform choices is the opposite case — without it the panel is unreachable by keyboard, since
   * it is portalled to the end of the body and nothing tab-ordered leads to it.
   */
  autoFocus?: boolean;
  /**
   * ARIA role for the panel. `menu` suits a list of commands; a grid of choices that stay put and
   * report their state wants `group`, because a menu's children must be menuitems and these are
   * buttons reporting `aria-pressed`.
   */
  panelRole?: "menu" | "group" | "dialog";
  /**
   * Panel contents. Given a function, it is called with a `close` callback — what a panel holding
   * *choices* needs, since picking one should shut the panel and nothing else here can do that.
   * A plain node keeps working unchanged, which is what every toolbar caller passes.
   */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const rawLeft = align === "end" ? rect.right - panelWidth : rect.left;
    const left = Math.max(margin, Math.min(window.innerWidth - panelWidth - margin, rawLeft));
    const measuredH = panelRef.current?.getBoundingClientRect().height ?? 220;
    let top = rect.bottom + gap;
    if (top + measuredH + margin > window.innerHeight) top = Math.max(margin, rect.top - gap - measuredH);
    setPos({ top, left });
  }, [align, panelWidth]);

  useEffect(() => {
    if (!open) return;
    // Position after paint so the panel can be measured; no auto-focus into it — content varies
    // (toggle groups, sliders, buttons) and forcing focus to "the first thing" is often the wrong
    // element here, unlike a plain list of menu items.
    window.requestAnimationFrame(() => {
      reposition();
      if (!autoFocus) return;
      // The choice already made, if there is one, so the panel opens on what is set rather than on
      // whatever happens to be first.
      const panel = panelRef.current;
      const target =
        panel?.querySelector<HTMLElement>('[aria-pressed="true"],[aria-checked="true"]') ??
        panel?.querySelector<HTMLElement>("button:not([disabled]),[tabindex]:not([tabindex='-1'])");
      target?.focus();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    // Focus goes back where it came from on any close, not only on Escape: a picker that leaves
    // focus on document.body strands a keyboard user at the top of the page.
    const restore = () => buttonRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (buttonRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (autoFocus && panelRef.current?.contains(document.activeElement)) restore();
    };
  }, [open, reposition, autoFocus]);

  const panel = open ? (
    <div
      ref={panelRef}
      role={panelRole}
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: panelWidth }}
      className={panelClassName ?? "fixed z-[1000] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2 shadow-lg"}
    >
      {typeof children === "function" ? children(() => setOpen(false)) : children}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName ?? "inline-flex h-8 w-8 items-center justify-center rounded-xl text-white/90 hover:bg-white/10"}
      >
        {trigger ?? <HamburgerGlyph />}
      </button>
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </>
  );
}

/** Plain three-line hamburger, matching the 24×24 / `currentColor` / rounded-stroke icons already
 * hand-drawn throughout the share viewer, so a caller that wants the default trigger gets an icon
 * that belongs next to them rather than an imported icon-set glyph in a different weight. */
function HamburgerGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}
