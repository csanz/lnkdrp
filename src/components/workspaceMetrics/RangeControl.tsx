"use client";

/**
 * The 7 / 30 / 90 day segmented control in the `/metrics` header actions.
 *
 * On Free the two longer options are locked rather than hidden: the workspace can see that more
 * history exists, and tapping one opens the upgrade modal instead of quietly showing 7 days under a
 * "90 days" label (the server clamps the window either way — see `range.clampedByPlan`).
 *
 * It is a real ARIA radiogroup, which means it owes the keyboard the radiogroup contract: one tab
 * stop, arrows to move. Declaring the role without it announced three equivalent radios and then
 * behaved like three buttons. Locked options keep their place in that traversal — a reader has to be
 * able to reach the thing that tells them it is a Pro feature — and say so in their accessible name
 * rather than only through a padlock glyph and a `title`.
 */
import { useCallback, useRef } from "react";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { cn } from "@/lib/cn";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { WORKSPACE_RANGE_DAYS, WORKSPACE_RANGE_KEYS, type WorkspaceRangeKey } from "@/lib/analytics/workspace/types";

/** 7 / 30 / 90 day segmented control; Free sees the longer two locked. */
export default function RangeControl({
  value,
  onChange,
  /** Null while the plan is still loading: nothing is locked until we know, so options never flip. */
  isFree,
  disabled = false,
}: {
  value: WorkspaceRangeKey;
  onChange: (next: WorkspaceRangeKey) => void;
  isFree: boolean | null;
  disabled?: boolean;
}) {
  const { openUpgrade } = useUpgradeModal();
  const groupRef = useRef<HTMLDivElement | null>(null);

  const lockedFor = (key: WorkspaceRangeKey) => isFree === true && key !== "7d";

  /** The one option that holds the group's tab stop: the checked one, else the first reachable. */
  const focusKey = WORKSPACE_RANGE_KEYS.find((k) => !lockedFor(k) && k === value) ?? WORKSPACE_RANGE_KEYS[0];

  /** Activate an option exactly as a click does — including the locked option's upgrade modal. */
  const activate = useCallback(
    (key: WorkspaceRangeKey) => {
      if (disabled) return;
      if (lockedFor(key)) {
        openUpgrade("analytics_history");
        return;
      }
      onChange(key);
    },
    // `lockedFor` closes over `isFree` only, and re-creating this per render is cheaper than a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, isFree, onChange, openUpgrade],
  );

  /**
   * Arrow keys move the selection and the focus together, which is what a radiogroup promises.
   * Home / End jump to the ends. Anything else is left to the browser.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = WORKSPACE_RANGE_KEYS;
      const current = keys.indexOf(value);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (Math.max(0, current) + 1) % keys.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (Math.max(0, current) - 1 + keys.length) % keys.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = keys.length - 1;
      if (next < 0) return;
      e.preventDefault();
      const key = keys[next]!;
      // Move focus first: activating a locked option opens a modal, and the reader should be able to
      // see which option they were on when it appeared.
      groupRef.current?.querySelector<HTMLButtonElement>(`[data-range-key="${key}"]`)?.focus();
      activate(key);
    },
    [activate, value],
  );

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Metrics range"
      onKeyDown={onKeyDown}
      className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1"
    >
      {WORKSPACE_RANGE_KEYS.map((key) => {
        const days = WORKSPACE_RANGE_DAYS[key];
        const locked = lockedFor(key);
        const active = !locked && key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            data-range-key={key}
            aria-checked={active}
            aria-disabled={locked || undefined}
            // Roving tab stop: one Tab reaches the group, arrows move inside it.
            tabIndex={key === focusKey ? 0 : -1}
            disabled={disabled}
            title={locked ? `${days} days of history is a Pro feature` : `Last ${days} days`}
            onClick={() => activate(key)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50",
              // Selected used to paint the same token `hover:` uses, so pointing at 30d while 7d was
              // selected drew two identical pills and the control stopped saying which range the
              // charts were showing. A solid inversion is a cue hover cannot borrow — the pattern
              // the activity filter chips already use. Dark keeps its old fill — light-only pass.
              active
                ? "bg-[var(--fg)] text-[var(--bg)] dark:bg-[var(--panel-hover)] dark:text-[var(--fg)]"
                : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            )}
          >
            {days}d
            {locked ? (
              <>
                <LockClosedIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                {/* The lock is decorative; this is what a screen reader hears. */}
                <span className="sr-only"> (Pro)</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
