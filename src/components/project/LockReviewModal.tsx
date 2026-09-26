"use client";

/**
 * The review a lock is, rather than the confirm it is not (docs/prds/lnkdrp-locked-projects.md,
 * decisions 26 and 31).
 *
 * Locking a room that already holds documents and readers changes four things at once, and three of
 * them are invisible from the button: documents leave workspace listings, colleagues lose sight of
 * the room, pending notifications for those colleagues are dropped, and Slack stops posting unless
 * the room has its own channel. The fifth thing is the one that turns a feature into a breach report:
 * **locking is not unsharing**. A room can be invisible to the workspace and open to the world at the
 * same time, so when a public link is live this dialog shows the exact `/p/:shareId` URL and puts the
 * fix one click away instead of a second journey through the links panel.
 *
 * And it preselects who keeps access, from what has already happened in the room. Counting who loses
 * access while making the person assemble the keeper list from nothing is how a lock breaks a week.
 */
import { useCallback, useEffect, useState } from "react";
import { LockClosedIcon, LockOpenIcon } from "@heroicons/react/24/outline";

import Modal from "@/components/modals/Modal";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type LockTarget = "locked" | "workspace";

type ReviewPerson = {
  userId: string;
  name: string | null;
  email: string | null;
  orgRole: string | null;
  because?: "creator" | "uploader" | "acted" | "you" | "member";
};

export type LockReviewPayload = {
  target: LockTarget;
  reviewRequired: boolean;
  token: string;
  members: { losing: ReviewPerson[]; keepers: ReviewPerson[]; current: ReviewPerson[]; cap: number };
  docs: { leavingWorkspaceListings: number; alsoInAnotherRoom: number };
  links: { live: number; publicPath: string | null; shareEnabled: boolean };
  slack: { mappedChannels: string[]; postsWillStop: boolean };
  notifications: { pendingRowsDropped: number };
};

/** What to call somebody in a list: their name, their address, or nothing useful at all. */
function personLabel(p: ReviewPerson): string {
  return p.name?.trim() || p.email || "Someone";
}

/** Why a name is preselected, in the words of what they did. */
function becauseLabel(p: ReviewPerson): string {
  switch (p.because) {
    case "you":
      return "you";
    case "creator":
      return "made this room";
    case "uploader":
      return "uploaded here";
    case "acted":
      return "worked here";
    case "member":
      return "already in";
    default:
      return "";
  }
}

export default function LockReviewModal({
  open,
  projectId,
  projectName,
  target,
  onClose,
  onDone,
}: {
  open: boolean;
  /** The id or slug the page is addressing this project by. */
  projectId: string;
  projectName: string;
  target: LockTarget;
  onClose: () => void;
  /** Called after the write lands, so the page can reload the project and the sidebar. */
  onDone: () => void;
}) {
  const [review, setReview] = useState<LockReviewPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [turnOffPublicLink, setTurnOffPublicLink] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTempUser(
        `/api/projects/${encodeURIComponent(projectId)}/lock-review?target=${target}`,
        { cache: "no-store" },
      );
      const json = (await res.json().catch(() => ({}))) as { review?: LockReviewPayload; error?: string };
      if (!res.ok || !json.review) {
        setError(json.error || "Could not work out what this would do.");
        return;
      }
      setReview(json.review);
      // Preselected from history, and unchecking a name is the act of removing access.
      const next: Record<string, boolean> = {};
      for (const p of json.review.members.keepers) next[p.userId] = true;
      setKeep(next);
      setTurnOffPublicLink(false);
    } catch {
      setError("Could not work out what this would do.");
    } finally {
      setLoading(false);
    }
  }, [projectId, target]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const keepUserIds = Object.entries(keep)
    .filter(([, on]) => on)
    .map(([id]) => id);

  async function confirm() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          visibility: target,
          reviewToken: review.token,
          ...(target === "locked" ? { keepUserIds } : {}),
          // The same request, so the room is never briefly private and publicly shared while somebody
          // walks to the links panel.
          ...(target === "locked" && turnOffPublicLink ? { shareEnabled: false } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error || "That did not go through.");
        return;
      }
      onDone();
      onClose();
    } catch {
      setError("That did not go through.");
    } finally {
      setBusy(false);
    }
  }

  const locking = target === "locked";
  const Icon = locking ? LockClosedIcon : LockOpenIcon;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      ariaLabel={locking ? "Make this data room private" : "Open this data room to the workspace"}
      width={620}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
            <Icon className="h-4 w-4 text-[var(--fg)]" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold text-[var(--fg)]">
              {locking ? "Make this data room private" : "Open this data room to the workspace"}
            </div>
            <div className="mt-0.5 truncate text-[13px] text-[var(--muted-2)]">{projectName}</div>
          </div>
        </div>

        {loading ? (
          <div className="text-[13px] text-[var(--muted-2)]">Working out what this does…</div>
        ) : review ? (
          <>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[13px] leading-6 text-[var(--muted)]">
              {locking ? (
                <>
                  Only the people you keep below will see this room. For everyone else in the workspace
                  it is not restricted, it is absent: no row in any list, no documents, no activity, no
                  notifications. Workspace owners get no special access either.
                </>
              ) : (
                <>
                  Everyone in the workspace will see this room again, including its documents and its
                  whole history. The member list is kept, so you can make it private again later.
                </>
              )}
            </div>

            <ul className="space-y-1.5 text-[13px] text-[var(--muted)]">
              {locking ? (
                <li>
                  <strong className="font-semibold text-[var(--fg)]">{review.members.losing.length}</strong>{" "}
                  {review.members.losing.length === 1 ? "person" : "people"} in this workspace will no longer see it
                  {review.members.losing.length
                    ? `: ${review.members.losing.slice(0, 5).map(personLabel).join(", ")}${review.members.losing.length > 5 ? ` and ${review.members.losing.length - 5} more` : ""}`
                    : ""}
                  .
                </li>
              ) : null}
              <li>
                <strong className="font-semibold text-[var(--fg)]">{review.docs.leavingWorkspaceListings}</strong>{" "}
                {review.docs.leavingWorkspaceListings === 1 ? "document" : "documents"}{" "}
                {locking ? "leave workspace lists and search" : "come back to workspace lists and search"}
                {review.docs.alsoInAnotherRoom
                  ? `; ${review.docs.alsoInAnotherRoom} of them also live in another room and stay visible there`
                  : ""}
                .
              </li>
              {locking && review.notifications.pendingRowsDropped ? (
                <li>
                  <strong className="font-semibold text-[var(--fg)]">{review.notifications.pendingRowsDropped}</strong>{" "}
                  pending email {review.notifications.pendingRowsDropped === 1 ? "notification" : "notifications"} for
                  people outside the room are dropped. Mail already sent has gone, and one batch may
                  already be on its way.
                </li>
              ) : null}
              {locking && review.slack.postsWillStop ? (
                <li>
                  Slack posts for this room stop until you map a channel. A private room never posts to
                  the catch-all channel.
                </li>
              ) : null}
              {locking && review.slack.mappedChannels.length ? (
                <li>
                  Activity keeps posting to {review.slack.mappedChannels.map((c) => `#${c.replace(/^#/, "")}`).join(", ")}
                  , so anyone in there can see this private room&apos;s activity.
                </li>
              ) : null}
            </ul>

            {locking && review.links.publicPath ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[13px] leading-6 text-amber-900">
                <div className="font-semibold">This data room is still shared publicly.</div>
                <div className="mt-1">
                  Locking changes who inside this workspace can see it, not who outside can. Anyone
                  holding this link keeps their access:
                </div>
                <div className="mt-1 break-all font-mono text-[12px]">{review.links.publicPath}</div>
                <label className="mt-2 flex items-start gap-2 font-medium">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={turnOffPublicLink}
                    disabled={busy}
                    onChange={(e) => setTurnOffPublicLink(e.target.checked)}
                  />
                  <span>
                    Turn off the public link too ({review.links.live}{" "}
                    {review.links.live === 1 ? "link" : "links"} live)
                  </span>
                </label>
              </div>
            ) : null}

            {locking ? (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  Who keeps access
                </div>
                <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                  Preselected from what has already happened in this room. Unchecking a name removes
                  their access. You are always in.
                </div>
                <ul className="mt-2 max-h-[220px] space-y-1 overflow-auto pr-1">
                  {review.members.keepers.concat(review.members.losing).map((p) => {
                    const isYou = p.because === "you";
                    const why = becauseLabel(p);
                    return (
                      <li key={p.userId}>
                        <label className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] text-[var(--fg)] hover:bg-[var(--panel-hover)]">
                          <input
                            type="checkbox"
                            checked={isYou ? true : Boolean(keep[p.userId])}
                            disabled={busy || isYou}
                            onChange={(e) => setKeep((s) => ({ ...s, [p.userId]: e.target.checked }))}
                          />
                          <span className="min-w-0 flex-1 truncate">{personLabel(p)}</span>
                          {why ? <span className="shrink-0 text-[11px] text-[var(--muted-2)]">{why}</span> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                  {keepUserIds.length} of {review.members.cap} people.
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {error ? <div className="text-sm font-medium text-red-700">{error}</div> : null}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
            disabled={busy || loading || !review}
            onClick={() => void confirm()}
          >
            {busy ? "Saving…" : locking ? "Make it private" : "Open it up"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
