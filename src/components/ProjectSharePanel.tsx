/**
 * ProjectSharePanel — the project page's right column (docs/prds/lnkdrp-project-links.md).
 *
 * The project-shaped twin of `DocSharePanel`, and deliberately the same shell: one
 * `rounded-2xl … bg-[var(--panel)] p-5` container holding `LinksManager variant="panel"` — the
 * default link, its URL with a copy button, what it does, its viewers, and the count as the way
 * through to `/project/:projectId/links` — followed by the same `QuickStats` analytics card the
 * document rail carries in that slot.
 *
 * The third shape this rail has had, and the first that matches the document one. It began as a
 * single public URL and a switch (a project could own only one link); `ProjectLinksPanel` replaced
 * that with a full link manager crammed into the rail — every link as a card, per-row switches and
 * menus, no page to send anyone to, and no analytics anywhere. The management now lives on
 * `/project/:projectId/links`, exactly as it does for documents, and this panel keeps the summary.
 *
 * The one thing a document panel has no counterpart for sits **below** the summary, in its own
 * card: the project-level sharing switch, which is the only control that acts on every link at
 * once. That is why it is not another row inside the links card.
 */
"use client";

import Link from "next/link";

import LinksManager from "@/components/links/LinksManager";
import QuickStats from "@/components/metrics/QuickStats";

type Props = {
  /** The project id (the route param is named `projectSlug`; it has always carried an id). */
  projectId: string;
  projectName?: string;
  /** `Project.shareId` — the default link's slug, for the "Open public share page" link. */
  shareId?: string | null;
  /** Whether `/p/:shareId` resolves at all. Mirrors the document "Share enabled" switch. */
  shareEnabled: boolean;
  /** Called with the next value when the master switch is toggled; the parent persists it. */
  onShareEnabledChange: (next: boolean) => void;
  /** Disables the master switch while a save is in flight. */
  shareBusy?: boolean;
  /** Owner/admin — project link writes take `admin`, one rank above a document link's `member`. */
  canManage: boolean;
  /** A failed `shareEnabled` save, rendered under the switch it belongs to. */
  error?: string | null;
};

/** The master switch's control, matching `ShareLinkModal`'s `SwitchRow` at panel scale. */
function Switch({
  checked,
  disabled,
  busy,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy ? true : undefined}
      disabled={disabled}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        checked ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
        disabled ? "opacity-50" : "cursor-pointer",
      ].join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={[
          "inline-block h-4 w-4 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}

/** Render the project's share summary: the default link, then the project-wide sharing switch. */
export default function ProjectSharePanel({
  projectId,
  projectName,
  shareId = null,
  shareEnabled,
  onShareEnabledChange,
  shareBusy = false,
  canManage,
  error = null,
}: Props) {
  return (
    // The same shell as `DocSharePanel`: its own scroll only at `lg`, where the page's columns are
    // pinned to the viewport; below that the page scrolls and the rail takes its natural height.
    <aside className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 lg:min-h-0 lg:overflow-auto">
      {/* 1) Links — the default link, the count, and the way through to /project/:id/links */}
      <LinksManager scope={{ kind: "project", id: projectId }} variant="panel" canManage={canManage} />

      {/* 2) Analytics — the same card the document rail carries, in the same slot under the links
             summary. `QuickStats` is scope-parameterised (it was `DocQuickStats`), so this is the
             document's card rather than a project-shaped imitation of it: same header, same five
             tiles, same two rankings, same smooth area with count labels. Only the fifth tile's
             noun changes, because a project's "how much was reached" is documents, not pages.
             Without it the project rail was two cards and ~500px of nothing where the document's
             engagement glimpse sits — the exact surface the user's screenshot was of. */}
      <div className="mt-4">
        <QuickStats scope={{ kind: "project", id: projectId }} />
      </div>

      {/* 3) Project sharing — below the links it governs, in the same card shape as the summary. */}
      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--fg)]">Project sharing</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted)]">
              {shareEnabled
                ? "Turning this off disables every link at once."
                : "Sharing is off. Every link shows “This project is no longer shared.”"}
            </div>
          </div>
          <Switch
            checked={shareEnabled}
            busy={shareBusy}
            disabled={shareBusy || !canManage}
            label="Project sharing"
            onChange={onShareEnabledChange}
          />
        </div>

        {error ? (
          <div className="mt-2 text-[12px] font-medium text-red-700 dark:text-red-300" role="alert">
            {error}
          </div>
        ) : null}

        {/* The recipient's view of the default link. `Project.shareId` is kept pointing at the
            default link by `syncProjectShareState`, so this needs no second fetch of the list
            `LinksManager` above already owns. */}
        {shareId ? (
          <div className="mt-3 border-t border-[var(--divider)] pt-3">
            <Link
              href={shareEnabled ? `/p/${encodeURIComponent(shareId)}` : "#"}
              target="_blank"
              className={[
                "text-[12px] font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline",
                shareEnabled ? "" : "pointer-events-none opacity-50",
              ].join(" ")}
              aria-disabled={!shareEnabled}
              aria-label={`Open public share page${projectName ? ` for ${projectName}` : ""}`}
            >
              Open public share page
            </Link>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
