/**
 * Workspace manager for `/preferences` — org switching + org creation + invite links.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/modals/Modal";
import { fetchJson } from "@/lib/http/fetchJson";
import { refreshOrgsCache } from "@/lib/orgsCache";
import { useNavigationLocked } from "@/app/providers";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";
import Pill from "@/components/ui/Pill";
import { initials } from "@/lib/orgs/orgsClient";
import { useOrgsSnapshot } from "@/lib/orgs/useOrgsSnapshot";

export default function WorkspaceManager() {
  const { session, stableOrgs, activeOrgId, orgsBusy, orgsError } = useOrgsSnapshot();
  const navLocked = useNavigationLocked();

  const [orgActionBusy, setOrgActionBusy] = useState(false);

  const [showAllWorkspacesModal, setShowAllWorkspacesModal] = useState(false);
  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);

  const [createOrgName, setCreateOrgName] = useState("");
  const [createOrgError, setCreateOrgError] = useState<string | null>(null);

  const [inviteRole, setInviteRole] = useState<"member" | "viewer" | "admin">("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string>("");
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const inviteLinkCopiedTimerRef = useRef<number | null>(null);
  const [existingInvitesBusy, setExistingInvitesBusy] = useState(false);
  const [existingInvitesError, setExistingInvitesError] = useState<string | null>(null);
  const [existingInvites, setExistingInvites] = useState<
    Array<{
      id?: string | null;
      inviteUrl: string | null;
      role: string;
      expiresAt: string | null;
      redeemedAt: string | null;
      createdDate: string | null;
    }>
  >([]);
  const [inviteFilter, setInviteFilter] = useState<"not_used" | "used" | "expired" | "all">("not_used");

  const currentOrg = useMemo(() => {
    if (!activeOrgId) return null;
    return stableOrgs.find((o) => o.id === activeOrgId) ?? null;
  }, [activeOrgId, stableOrgs]);

  const activeOrgRole = useMemo(() => {
    if (!activeOrgId) return null;
    const found = stableOrgs.find((o) => o.id === activeOrgId);
    return found?.role ?? null;
  }, [activeOrgId, stableOrgs]);
  const isPersonalOrg = currentOrg?.type === "personal";
  // Personal workspaces are single-user; invites are not allowed.
  const canInvite = !isPersonalOrg && (activeOrgRole === "owner" || activeOrgRole === "admin");

  const switchOrg = useCallback(
    async (nextOrgId: string) => {
      if (!nextOrgId) return;
      if (!session?.user) return;
      if (navLocked) return;
      if (orgActionBusy) return;
      setOrgActionBusy(true);
      try {
        if (typeof window !== "undefined") {
          const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          try {
            await switchWorkspaceWithOverlay({ orgId: nextOrgId, returnTo });
          } catch {
            window.location.assign(
              `/org/switch?orgId=${encodeURIComponent(nextOrgId)}&returnTo=${encodeURIComponent(returnTo)}`,
            );
          }
        }
      } finally {
        setOrgActionBusy(false);
      }
    },
    [session?.user, navLocked, orgActionBusy],
  );

  const createOrg = useCallback(async () => {
    if (!session?.user) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    const name = createOrgName.trim();
    if (!name) {
      setCreateOrgError("Org name is required");
      return;
    }
    setOrgActionBusy(true);
    setCreateOrgError(null);
    try {
      const json = await fetchJson<{ org?: { id: string } }>("/api/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const newOrgId = typeof json?.org?.id === "string" ? json.org.id : "";
      setShowCreateOrgModal(false);
      setCreateOrgName("");

      if (newOrgId) {
        if (typeof window !== "undefined") {
          const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          try {
            await switchWorkspaceWithOverlay({ orgId: newOrgId, returnTo });
          } catch {
            window.location.assign(
              `/org/switch?orgId=${encodeURIComponent(newOrgId)}&returnTo=${encodeURIComponent(returnTo)}`,
            );
          }
          return;
        }
      }
      // Best-effort refresh.
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
    } catch (e) {
      setCreateOrgError(e instanceof Error ? e.message : "Failed to create org");
    } finally {
      setOrgActionBusy(false);
    }
  }, [session?.user, navLocked, orgActionBusy, createOrgName]);

  const loadExistingInvites = useCallback(async (opts?: { force?: boolean }) => {
    if (!session?.user) return;
    if (!activeOrgId) return;
    if (!canInvite) return;
    if (navLocked) return;

    const force = Boolean(opts?.force);
    if (!force) setExistingInvitesBusy(true);
    setExistingInvitesError(null);
    try {
      const json = await fetchJson<{ invites?: typeof existingInvites }>(
        `/api/org-invites?orgId=${encodeURIComponent(activeOrgId)}`,
        { method: "GET" },
      );
      setExistingInvites(Array.isArray(json?.invites) ? json.invites : []);
    } catch (e) {
      setExistingInvitesError(e instanceof Error ? e.message : "Failed to load invite links");
    } finally {
      if (!force) setExistingInvitesBusy(false);
    }
  }, [session?.user, activeOrgId, canInvite, navLocked, existingInvites]);

  useEffect(() => {
    if (!showInviteModal) return;
    setInviteFilter("not_used");
    setInviteError(null);
    setInviteLink("");
    void loadExistingInvites();
  }, [showInviteModal, loadExistingInvites]);

  const inviteCounts = useMemo(() => {
    const now = Date.now();
    let used = 0;
    let expired = 0;
    let notUsed = 0;
    for (const inv of existingInvites ?? []) {
      const isUsed = Boolean(inv.redeemedAt);
      const e = inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
      const isExpired = !isUsed && Number.isFinite(e) && e <= now;
      if (isUsed) used++;
      else if (isExpired) expired++;
      else notUsed++;
    }
    return { used, expired, notUsed, all: (existingInvites ?? []).length };
  }, [existingInvites]);

  const filteredInvites = useMemo(() => {
    const now = Date.now();
    const rows = existingInvites ?? [];
    const isExpired = (inv: { expiresAt: string | null }) => {
      const e = inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
      return Number.isFinite(e) && e <= now;
    };
    const isUsed = (inv: { redeemedAt: string | null }) => Boolean(inv.redeemedAt);
    if (inviteFilter === "all") return rows;
    if (inviteFilter === "used") return rows.filter((i) => isUsed(i));
    if (inviteFilter === "expired") return rows.filter((i) => !isUsed(i) && isExpired(i));
    return rows.filter((i) => !isUsed(i) && !isExpired(i));
  }, [existingInvites, inviteFilter]);

  const createInvite = useCallback(async () => {
    if (!session?.user) return;
    if (!activeOrgId) return;
    if (!canInvite) return;
    if (navLocked) return;
    if (inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const json = await fetchJson<{ invite?: { id?: string; inviteUrl?: string; expiresAt?: string } }>("/api/org-invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: activeOrgId, role: inviteRole, ttlDays: 14 }),
      });
      const url = typeof json?.invite?.inviteUrl === "string" ? json.invite.inviteUrl : "";
      if (!url) throw new Error("Failed to generate invite link");
      setInviteLink(url);

      try {
        await navigator.clipboard?.writeText?.(url);
        setInviteLinkCopied(true);
        if (inviteLinkCopiedTimerRef.current) window.clearTimeout(inviteLinkCopiedTimerRef.current);
        inviteLinkCopiedTimerRef.current = window.setTimeout(() => setInviteLinkCopied(false), 1500);
      } catch {
        // ignore
      }

      // Refresh list so it appears immediately.
      await loadExistingInvites({ force: true });
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "Failed to create invite");
    } finally {
      setInviteBusy(false);
    }
  }, [session?.user, activeOrgId, canInvite, navLocked, inviteBusy, inviteRole, loadExistingInvites]);

  useEffect(() => {
    return () => {
      if (inviteLinkCopiedTimerRef.current) window.clearTimeout(inviteLinkCopiedTimerRef.current);
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--fg)]">Active workspace</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            {orgsBusy ? "Loading…" : orgsError ? orgsError : currentOrg ? currentOrg.name : "—"}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {currentOrg?.type ? <Pill>{currentOrg.type === "personal" ? "Personal" : "Org"}</Pill> : null}
            {currentOrg?.role ? <Pill>{currentOrg.role}</Pill> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
            disabled={navLocked || orgActionBusy}
            onClick={() => setShowAllWorkspacesModal(true)}
          >
            All workspaces…
          </button>
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
            disabled={navLocked || orgActionBusy}
            onClick={() => {
              setCreateOrgError(null);
              setCreateOrgName("");
              setShowCreateOrgModal(true);
            }}
          >
            Create org…
          </button>
          <button
            type="button"
            className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
            disabled={navLocked || orgActionBusy || !canInvite}
            onClick={() => setShowInviteModal(true)}
            title={!canInvite ? "Only owners/admins can invite" : "Invite a member"}
          >
            Invite member…
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
        <div className="text-[12px] font-semibold text-[var(--muted-2)]">Quick switch</div>
        <div className="mt-2 divide-y divide-[var(--border)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
          {stableOrgs.length ? (
            stableOrgs.map((o) => {
              const isActive = Boolean(activeOrgId && o.id === activeOrgId);
              const badge = o.type === "personal" ? "Personal" : "Org";
              return (
                <button
                  key={o.id}
                  type="button"
                  disabled={navLocked || orgActionBusy || isActive}
                  className={[
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
                    isActive ? "bg-[var(--panel-hover)]" : "hover:bg-[var(--panel-hover)]",
                    navLocked || orgActionBusy ? "opacity-60" : "",
                  ].join(" ")}
                  onClick={() => void switchOrg(o.id)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--panel-hover)] text-[11px] font-semibold text-[var(--fg)]">
                      {initials(o.name)}
                    </span>
                    <span className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{o.name}</div>
                      <div className="text-[11px] text-[var(--muted-2)]">
                        {badge} • {o.role}
                      </div>
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] font-semibold text-[var(--muted-2)]">
                    {isActive ? "Active" : "Switch"}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="px-3 py-3 text-[12px] text-[var(--muted-2)]">{orgsBusy ? "Loading…" : "No workspaces."}</div>
          )}
        </div>
      </div>

      <Modal
        open={showAllWorkspacesModal}
        onClose={() => setShowAllWorkspacesModal(false)}
        ariaLabel="All workspaces"
        panelClassName="w-[min(680px,calc(100vw-32px))] h-[min(80vh,720px)]"
        contentClassName="max-h-none h-full overflow-hidden"
      >
        <div className="flex h-full flex-col">
          <div className="text-base font-semibold text-[var(--fg)]">Workspaces</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">Choose a workspace to switch into.</div>

          <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <div className="divide-y divide-[var(--border)]">
              {stableOrgs.map((o) => {
                const isActive = Boolean(activeOrgId && o.id === activeOrgId);
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={navLocked || orgActionBusy || isActive}
                    className={[
                      "flex w-full items-center justify-between gap-3 px-4 py-3 text-left",
                      isActive ? "bg-[var(--panel-hover)]" : "hover:bg-[var(--panel-hover)]",
                      navLocked || orgActionBusy ? "opacity-60" : "",
                    ].join(" ")}
                    onClick={() => {
                      void switchOrg(o.id);
                      setShowAllWorkspacesModal(false);
                    }}
                    title={o.role}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--panel-hover)] text-[11px] font-semibold text-[var(--fg)]">
                        {initials(o.name)}
                      </span>
                      <span className="min-w-0">
                        <div className="truncate text-[14px] font-semibold text-[var(--fg)]">{o.name}</div>
                        <div className="text-[12px] text-[var(--muted-2)]">
                          {o.type === "personal" ? "Personal" : "Org"} • {o.role}
                        </div>
                      </span>
                    </span>
                    <span className="shrink-0">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--panel)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted-2)]">
                          Active
                        </span>
                      ) : (
                        <span className="text-[12px] text-[var(--muted-2)]">Switch</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-[13px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)]"
              onClick={() => setShowAllWorkspacesModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showCreateOrgModal} onClose={() => setShowCreateOrgModal(false)} ariaLabel="Create org">
        <div className="text-base font-semibold text-[var(--fg)]">Create org</div>
        <div className="mt-3">
          <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Name</label>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
            value={createOrgName}
            onChange={(e) => setCreateOrgName(e.target.value)}
            placeholder="Acme"
            disabled={orgActionBusy}
          />
          {createOrgError ? <div className="mt-2 text-[12px] text-red-500">{createOrgError}</div> : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-[13px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
              disabled={orgActionBusy}
              onClick={() => setShowCreateOrgModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
              disabled={orgActionBusy || !createOrgName.trim()}
              onClick={() => void createOrg()}
            >
              {orgActionBusy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        ariaLabel="Invite member"
        panelClassName="w-[min(880px,calc(100vw-32px))] h-[min(80vh,760px)]"
        contentClassName="max-h-none h-full overflow-hidden"
      >
        <div className="flex h-full flex-col">
          <div className="text-base font-semibold text-[var(--fg)]">Invite member</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">Generate invite links for the active workspace.</div>

          <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-hidden">
            <div className="grid min-h-0 grid-cols-1 gap-6 md:grid-cols-[1fr_320px]">
              {/* Left: existing links */}
              <div className="min-h-0">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[12px] font-semibold text-[var(--muted-2)]">Existing invite links</div>
                    <div className="flex items-center gap-2">
                      {(
                        [
                          ["not_used", `Not used (${inviteCounts.notUsed})`],
                          ["used", `Used (${inviteCounts.used})`],
                          ["expired", `Expired (${inviteCounts.expired})`],
                          ["all", `All (${inviteCounts.all})`],
                        ] as const
                      ).map(([k, label]) => (
                        <button
                          key={k}
                          type="button"
                          className={[
                            "rounded-lg px-2 py-1 text-[12px] font-semibold",
                            inviteFilter === k
                              ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                              : "text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                          ].join(" ")}
                          onClick={() => setInviteFilter(k)}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="rounded-lg px-2 py-1 text-[12px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                        disabled={existingInvitesBusy || !canInvite || !activeOrgId}
                        onClick={() => void loadExistingInvites({ force: true })}
                      >
                        Refresh
                      </button>
                    </div>
                  </div>

                  {existingInvitesBusy ? <div className="text-[12px] text-[var(--muted-2)]">Loading…</div> : null}
                  {existingInvitesError ? <div className="text-[12px] text-red-500">{existingInvitesError}</div> : null}
                  {!existingInvitesBusy && filteredInvites.length === 0 ? (
                    <div className="text-[12px] text-[var(--muted-2)]">No invite links in this view.</div>
                  ) : null}

                  <div className="h-[360px] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
                    <div className="grid grid-cols-[110px_1fr_110px] gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] font-semibold text-[var(--muted-2)]">
                      <div>Role</div>
                      <div>Link</div>
                      <div>Expires</div>
                    </div>
                    {filteredInvites.map((inv, idx) => {
                      const url = typeof inv.inviteUrl === "string" ? inv.inviteUrl : "";
                      const expiresLabel = inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : "—";
                      return (
                        <div
                          key={`${inv.id ?? inv.createdDate ?? "x"}:${idx}`}
                          className="grid grid-cols-[110px_1fr_110px] items-center gap-2 px-3 py-2 text-[12px] text-[var(--fg)]"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-semibold">{inv.role || "member"}</div>
                            <div className="text-[11px] text-[var(--muted-2)]">{inv.redeemedAt ? "Used" : "Not used"}</div>
                          </div>
                          <div className="min-w-0">
                            {url ? (
                              <button
                                type="button"
                                className="w-full truncate text-left text-[12px] text-[var(--muted-2)] hover:text-[var(--fg)]"
                                title={url}
                                onClick={() => void navigator.clipboard?.writeText?.(url)}
                              >
                                {url}
                              </button>
                            ) : (
                              <div className="truncate text-[12px] text-[var(--muted-2)]">Legacy invite (no link saved)</div>
                            )}
                          </div>
                          <div className="text-[12px] text-[var(--muted-2)]">{expiresLabel}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Right: generate invite */}
              <div className="space-y-3">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                  <div className="text-sm font-semibold text-[var(--fg)]">Generate invite</div>
                  <div className="mt-1 text-[12px] text-[var(--muted-2)]">Create a new link for someone to join.</div>

                  <div className="mt-4 space-y-3">
                    <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Role</label>
                    <select
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "member" | "viewer" | "admin")}
                      disabled={inviteBusy}
                    >
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg px-3 py-2 text-[13px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                        disabled={inviteBusy}
                        onClick={() => setShowInviteModal(false)}
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                        disabled={inviteBusy || !canInvite}
                        onClick={() => void createInvite()}
                      >
                        {inviteBusy ? "Generating…" : inviteLink ? "Generate new link" : "Generate link"}
                      </button>
                    </div>

                    {inviteError ? <div className="text-[12px] text-red-500">{inviteError}</div> : null}

                    {inviteLink ? (
                      <div className="space-y-2">
                        <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Invite link</label>
                        <input
                          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)]"
                          value={inviteLink}
                          readOnly
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <div className="text-[11px] text-[var(--muted-2)]" aria-live="polite">
                          {inviteLinkCopied
                            ? "Copied."
                            : "Select the link (or click it in the table) to copy. Anyone with the link can join until it expires."}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}


