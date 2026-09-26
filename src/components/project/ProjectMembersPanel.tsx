"use client";

/**
 * Who a private data room is for, on the room's own page (docs/prds/lnkdrp-locked-projects.md,
 * decisions 23, 24 and 26).
 *
 * The one sentence at the top is the whole feature: this room exists for the people on this list, and
 * for everybody else in the workspace it is absent rather than restricted. The permanent line under
 * the roster is the part people get wrong in both directions — **workspace owners are not on this list
 * unless somebody added them**, and removing a person does not touch the room's share links, so a
 * recipient who was sent a `/p/` URL keeps their access.
 *
 * There is no owner row and no admin row. An owner who is not in the room cannot load this panel at
 * all: the route answers 404 for them exactly as it does for a room that never existed.
 */
import { useCallback, useEffect, useState } from "react";
import { LockClosedIcon, LockOpenIcon, UserPlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import LockReviewModal from "@/components/project/LockReviewModal";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type MemberRow = {
  userId: string;
  name: string | null;
  email: string | null;
  role: "editor" | "reader";
  via: "creator" | "added" | "break_glass";
  orgRole: string | null;
  addedDate: string | null;
  reason: string;
};

type Candidate = { userId: string; name: string | null; email: string | null; orgRole: string | null };

type MembersPayload = {
  project?: { id: string; name: string; visibility: "workspace" | "locked"; visibleBecause: string };
  members?: MemberRow[];
  candidates?: Candidate[];
  cap?: number;
  membersCanManageLinks?: boolean;
  error?: string;
};

/** What to call somebody in the roster: their name, their address, or nothing useful at all. */
function label(p: { name: string | null; email: string | null }): string {
  return p.name?.trim() || p.email || "Someone";
}

export default function ProjectMembersPanel({
  projectId,
  projectName,
  locked,
  /** Hidden entirely in a personal workspace: a one-person workspace has nobody to hide from. */
  isPersonalWorkspace,
  /** Whether this viewer may change anything here (`viewer` may read a workspace, not rearrange it). */
  canManage,
  onVisibilityChanged,
}: {
  projectId: string;
  projectName: string;
  locked: boolean;
  isPersonalWorkspace: boolean;
  canManage: boolean;
  onVisibilityChanged: () => void;
}) {
  const [data, setData] = useState<MembersPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"editor" | "reader">("editor");
  const [reviewTarget, setReviewTarget] = useState<"locked" | "workspace" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as MembersPayload;
      if (!res.ok) {
        setError(json.error || "Could not load the member list.");
        return;
      }
      setData(json);
    } catch {
      setError("Could not load the member list.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // The roster only exists for a locked room, but the panel loads it either way so the counts are
    // right the instant a lock lands and so an unlock can say the list is being kept.
    void load();
  }, [load, locked]);

  async function add() {
    const userId = addUserId.trim();
    if (!userId) return;
    setBusyUserId(userId);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role: addRole }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error || "Could not add that person.");
        return;
      }
      setAddUserId("");
      await load();
    } catch {
      setError("Could not add that person.");
    } finally {
      setBusyUserId(null);
    }
  }

  async function remove(userId: string) {
    setBusyUserId(userId);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}/members`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error || "Could not remove that person.");
        return;
      }
      await load();
      onVisibilityChanged();
    } catch {
      setError("Could not remove that person.");
    } finally {
      setBusyUserId(null);
    }
  }

  if (isPersonalWorkspace) return null;

  const members = data?.members ?? [];
  const candidates = data?.candidates ?? [];
  const cap = data?.cap ?? 200;
  const atCap = members.length >= cap;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {locked ? (
              <LockClosedIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
            ) : null}
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
              {locked ? "Private data room" : "Who can see this room"}
            </div>
          </div>
          <div className="mt-1 text-sm text-[var(--muted)]">
            {locked
              ? "This room exists for the people below. For everyone else in this workspace it does not appear at all."
              : "Everyone in this workspace can see this room. Make it private to limit it to the people you choose."}
          </div>
        </div>
        {canManage ? (
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
            onClick={() => setReviewTarget(locked ? "workspace" : "locked")}
          >
            {locked ? (
              <>
                <LockOpenIcon className="h-3.5 w-3.5" aria-hidden="true" />
                Open it up
              </>
            ) : (
              <>
                <LockClosedIcon className="h-3.5 w-3.5" aria-hidden="true" />
                Make private
              </>
            )}
          </button>
        ) : null}
      </div>

      {locked ? (
        <>
          <ul className="mt-4 space-y-1">
            {loading && !members.length ? (
              <li className="text-[13px] text-[var(--muted-2)]">Loading…</li>
            ) : !members.length ? (
              <li className="text-[13px] text-[var(--muted-2)]">Nobody is in this room yet.</li>
            ) : null}
            {members.map((m) => (
              <li
                key={m.userId}
                className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-[var(--panel-hover)]"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]" title={m.email ?? undefined}>
                  {label(m)}
                </span>
                {m.via === "break_glass" ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                    added themselves
                  </span>
                ) : null}
                <span className="shrink-0 text-[11px] text-[var(--muted-2)]">{m.role}</span>
                {canManage ? (
                  <button
                    type="button"
                    aria-label={`Remove ${label(m)} from this room`}
                    title={`Remove ${label(m)} from this room`}
                    disabled={busyUserId === m.userId}
                    onClick={() => void remove(m.userId)}
                    className="shrink-0 rounded-md p-1 text-[var(--muted-2)] opacity-0 transition-opacity hover:text-[var(--fg)] focus:opacity-100 disabled:opacity-40 group-hover:opacity-100"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          {canManage ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                aria-label="Add a workspace member to this room"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-60"
                value={addUserId}
                disabled={busyUserId !== null || atCap || !candidates.length}
                onChange={(e) => setAddUserId(e.target.value)}
              >
                <option value="">{candidates.length ? "Add someone…" : "Everyone is already in"}</option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {label(c)}
                    {c.orgRole ? ` · ${c.orgRole}` : ""}
                  </option>
                ))}
              </select>
              <select
                aria-label="Their role in this room"
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-60"
                value={addRole}
                disabled={busyUserId !== null || atCap}
                onChange={(e) => setAddRole(e.target.value === "reader" ? "reader" : "editor")}
              >
                <option value="editor">Editor</option>
                <option value="reader">Reader</option>
              </select>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-2.5 text-[12px] font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
                disabled={!addUserId || busyUserId !== null || atCap}
                onClick={() => void add()}
              >
                <UserPlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                Add
              </button>
            </div>
          ) : null}

          <div className="mt-3 space-y-1.5 text-[12px] leading-5 text-[var(--muted-2)]">
            {/* The permanent line. Somebody will ask, and the honest answer is the whole design. */}
            <div>
              Workspace owners: none unless added. An owner can add themselves in an emergency, and
              everyone here is told.
            </div>
            <div>Adding someone shows them everything in this room, including what happened before they joined.</div>
            <div>
              Removing someone does not change this room&apos;s share links. Rotate them if they should
              lose recipient access too.
            </div>
            {data && data.membersCanManageLinks === false ? (
              <div className="font-medium text-amber-700">
                Nobody in this room can manage its share links. Add someone with the Admin workspace
                role, or ask an owner.
              </div>
            ) : null}
            {atCap ? <div>This room is at its limit of {cap} people.</div> : null}
          </div>
        </>
      ) : null}

      {error ? <div className="mt-3 text-[13px] font-medium text-red-700">{error}</div> : null}

      <LockReviewModal
        open={reviewTarget !== null}
        projectId={projectId}
        projectName={projectName}
        target={reviewTarget ?? "locked"}
        onClose={() => setReviewTarget(null)}
        onDone={() => {
          void load();
          onVisibilityChanged();
        }}
      />
    </div>
  );
}
