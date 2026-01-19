/**
 * Teams manager for `/dashboard?tab=teams` — members + invite links for the active workspace.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/http/fetchJson";
import {
  ORGS_CACHE_UPDATED_EVENT,
  readOrgsCacheSnapshot,
  refreshOrgsCache,
} from "@/lib/orgsCache";
import { useNavigationLocked } from "@/app/providers";

type OrgRow = { id: string; name: string; type: string; role: string; avatarUrl?: string | null };

type MemberRow = {
  userId: string;
  memberRole: string | null;
  email: string | null;
  name: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
  isTemp: boolean;
  isActive: boolean;
};

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--muted-2)]">
      {children}
    </span>
  );
}

function initials(nameOrEmail: string) {
  const s = nameOrEmail.trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString();
}

function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (!e || e.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

type TeamsSubtab = "members" | "invites";

function isTeamsSubtab(v: unknown): v is TeamsSubtab {
  return v === "members" || v === "invites";
}

function teamsSubtabFromSearchParams(searchParams: URLSearchParams | null): TeamsSubtab {
  const raw = searchParams?.get("subtab") ?? "";
  return isTeamsSubtab(raw) ? raw : "members";
}

export default function TeamsManager() {
  const { data: session } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navLocked = useNavigationLocked();

  const urlSubtab = teamsSubtabFromSearchParams(searchParams);
  const [tab, setTab] = useState<TeamsSubtab>(urlSubtab);

  // Keep internal state in sync with URL (supports refresh + back/forward).
  useEffect(() => {
    if (tab === urlSubtab) return;
    setTab(urlSubtab);
  }, [tab, urlSubtab]);

  const setSubtabInUrl = useCallback(
    (next: TeamsSubtab) => {
      const params = new URLSearchParams(searchParams?.toString());
      // Ensure the parent dashboard tab stays on Teams.
      params.set("tab", "teams");
      if (next === "invites") params.set("subtab", "invites");
      else params.delete("subtab");
      const qs = params.toString();
      router.replace(qs ? `/dashboard?${qs}` : "/dashboard", { scroll: false });
    },
    [router, searchParams],
  );

  const [orgsBusy, setOrgsBusy] = useState(false);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [serverActiveOrgId, setServerActiveOrgId] = useState<string | null>(null);

  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);

  const [inviteRole, setInviteRole] = useState<"member" | "viewer" | "admin">("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string>("");
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const inviteLinkCopiedTimerRef = useRef<number | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteEmailBusy, setInviteEmailBusy] = useState(false);
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [inviteEmailSentTo, setInviteEmailSentTo] = useState<string>("");

  const [existingInvitesBusy, setExistingInvitesBusy] = useState(false);
  const [existingInvitesError, setExistingInvitesError] = useState<string | null>(null);
  const [existingInvites, setExistingInvites] = useState<
    Array<{
      id?: string | null;
      inviteUrl: string | null;
      email?: string | null;
      role: string;
      expiresAt: string | null;
      redeemedAt: string | null;
      redeemedBy?: { userId: string; email: string | null; name: string | null } | null;
      createdDate: string | null;
    }>
  >([]);
  const [inviteFilter, setInviteFilter] = useState<"not_used" | "used" | "expired" | "all">("not_used");

  const activeOrgId = serverActiveOrgId ?? (session as any)?.activeOrgId ?? null;

  const stableOrgs = useMemo(() => {
    const rows = Array.isArray(orgs) ? [...orgs] : [];
    rows.sort((a, b) => {
      const aPersonal = a.type === "personal";
      const bPersonal = b.type === "personal";
      if (aPersonal && !bPersonal) return -1;
      if (bPersonal && !aPersonal) return 1;
      const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
      if (byName) return byName;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
    return rows;
  }, [orgs]);

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
  // Personal workspaces are single-user; teams + invites are not allowed.
  const canAdminTeams = !isPersonalOrg && (activeOrgRole === "owner" || activeOrgRole === "admin");
  const canInvite = canAdminTeams;
  // Avoid flashing "no permission" while org/role context is still loading.
  // Only show unauthorized once we have a resolved org + role.
  const teamsAuthResolved = Boolean(activeOrgId) && Boolean(currentOrg) && Boolean(activeOrgRole);

  const setPersonalMembers = useCallback(() => {
    const email = (session?.user?.email ?? "").trim() || null;
    const name = (session?.user?.name ?? "").trim() || null;
    setMembersError(null);
    setMembersBusy(false);
    setMembers([
      {
        userId: "me",
        memberRole: "owner",
        email,
        name,
        joinedAt: null,
        lastLoginAt: null,
        isTemp: false,
        isActive: true,
      },
    ]);
  }, [session?.user?.email, session?.user?.name]);

  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    const userKey = session.user.email ?? "";

    const cached = readOrgsCacheSnapshot(userKey);
    if (cached) {
      setOrgs(Array.isArray(cached.orgs) ? (cached.orgs as OrgRow[]) : []);
      setServerActiveOrgId(typeof cached.activeOrgId === "string" ? cached.activeOrgId : null);
      setOrgsError(null);
    } else {
      setOrgsBusy(true);
      setOrgsError(null);
    }

    void (async () => {
      try {
        // Avoid forced refresh on Teams tab load; rely on cache TTL for snappy UX.
        const snap = await refreshOrgsCache({ userKey, force: false });
        if (cancelled) return;
        if (snap) {
          setOrgs(Array.isArray(snap.orgs) ? (snap.orgs as OrgRow[]) : []);
          setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
          setOrgsError(null);
        }
      } catch (e) {
        if (cancelled) return;
        if (!cached) {
          setOrgs([]);
          setOrgsError(e instanceof Error ? e.message : "Failed to load workspaces");
          setServerActiveOrgId(null);
        }
      } finally {
        if (!cancelled) setOrgsBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  useEffect(() => {
    if (!session?.user) return;
    const userKey = session.user.email ?? "";

    function onCacheUpdated() {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      setOrgs(Array.isArray(snap.orgs) ? (snap.orgs as OrgRow[]) : []);
      setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
    }

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
    return () => window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
  }, [session?.user]);

  const loadMembers = useCallback(async () => {
    if (!session?.user) return;
    if (!activeOrgId) return;
    if (isPersonalOrg) {
      setPersonalMembers();
      return;
    }
    if (!canAdminTeams) return;
    if (navLocked) return;

    setMembersBusy(true);
    setMembersError(null);
    try {
      const json = await fetchJson<{ members?: MemberRow[] }>(`/api/orgs/${encodeURIComponent(activeOrgId)}/members`, {
        method: "GET",
      });
      setMembers(Array.isArray(json?.members) ? json.members : []);
    } catch (e) {
      setMembersError(e instanceof Error ? e.message : "Failed to load members");
      setMembers([]);
    } finally {
      setMembersBusy(false);
    }
  }, [session?.user, activeOrgId, isPersonalOrg, canAdminTeams, navLocked, setPersonalMembers]);

  const loadExistingInvites = useCallback(
    async (opts?: { force?: boolean }) => {
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
    },
    [session?.user, activeOrgId, canInvite, navLocked],
  );

  useEffect(() => {
    // Important: when switching workspaces, clear the previous workspace's rows immediately
    // so we never show "members/invites from workspace A" under "active workspace B".
    setMembersError(null);
    setMembers([]);
    setExistingInvitesError(null);
    setExistingInvites([]);
    setInviteError(null);
    setInviteLink("");
    setInviteEmailError(null);
    setInviteEmailSentTo("");
    if (tab === "members") void loadMembers();
    if (tab === "invites") {
      setInviteFilter("not_used");
      if (!isPersonalOrg) void loadExistingInvites();
    }
  }, [tab, loadMembers, loadExistingInvites, isPersonalOrg]);

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

  const inviteRowMeta = useCallback((inv: { expiresAt: string | null; redeemedAt: string | null }) => {
    const now = Date.now();
    const isUsed = Boolean(inv.redeemedAt);
    const e = inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
    const isExpired = !isUsed && Number.isFinite(e) && e <= now;
    const status = isUsed ? "Used" : isExpired ? "Expired" : "Not used";
    const expiresLabel = inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : "—";
    return { status, expiresLabel };
  }, []);

  const createInvite = useCallback(async () => {
    if (!session?.user) return;
    if (!activeOrgId) return;
    if (!canInvite) return;
    if (navLocked) return;
    if (inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const json = await fetchJson<{ invite?: { inviteUrl?: string } }>("/api/org-invites", {
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

      await loadExistingInvites({ force: true });
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "Failed to create invite");
    } finally {
      setInviteBusy(false);
    }
  }, [session?.user, activeOrgId, canInvite, navLocked, inviteBusy, inviteRole, loadExistingInvites]);

  const sendInviteEmail = useCallback(async () => {
    if (!session?.user) return;
    if (!activeOrgId) return;
    if (!canInvite) return;
    if (navLocked) return;
    if (inviteEmailBusy) return;
    const email = inviteEmail.trim().toLowerCase();
    if (!isValidEmail(email)) {
      setInviteEmailError("Enter a valid email address");
      return;
    }
    setInviteEmailBusy(true);
    setInviteEmailError(null);
    setInviteEmailSentTo("");
    try {
      const json = await fetchJson<{ invite?: { inviteUrl?: string; email?: string } }>("/api/org-invites/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: activeOrgId, role: inviteRole, ttlDays: 14, email }),
      });
      const url = typeof json?.invite?.inviteUrl === "string" ? json.invite.inviteUrl : "";
      const to = typeof json?.invite?.email === "string" ? json.invite.email : email;
      if (url) setInviteLink(url);
      setInviteEmailSentTo(to);
      await loadExistingInvites({ force: true });
    } catch (e) {
      setInviteEmailError(e instanceof Error ? e.message : "Failed to send invite email");
    } finally {
      setInviteEmailBusy(false);
    }
  }, [session?.user, activeOrgId, canInvite, navLocked, inviteEmailBusy, inviteEmail, inviteRole, loadExistingInvites]);

  const revokeMember = useCallback(
    async (userId: string) => {
      if (!session?.user) return;
      if (!activeOrgId) return;
      if (!canAdminTeams) return;
      if (navLocked) return;
      if (!userId) return;
      const ok = window.confirm("Remove this member from the workspace?");
      if (!ok) return;
      try {
        await fetchJson(`/api/orgs/${encodeURIComponent(activeOrgId)}/members/${encodeURIComponent(userId)}/revoke`, {
          method: "POST",
        });
        await loadMembers();
      } catch (e) {
        setMembersError(e instanceof Error ? e.message : "Failed to remove member");
      }
    },
    [session?.user, activeOrgId, canAdminTeams, navLocked, loadMembers],
  );

  useEffect(() => {
    return () => {
      if (inviteLinkCopiedTimerRef.current) window.clearTimeout(inviteLinkCopiedTimerRef.current);
    };
  }, []);

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
            className={[
              "rounded-xl border px-3 py-2 text-[13px] font-semibold",
              tab === "members"
                ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
                : "border-transparent bg-transparent text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            ].join(" ")}
            onClick={() => {
              setTab("members");
              setSubtabInUrl("members");
            }}
          >
            Members
          </button>
          <button
            type="button"
            className={[
              "rounded-xl border px-3 py-2 text-[13px] font-semibold",
              tab === "invites"
                ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
                : "border-transparent bg-transparent text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
            ].join(" ")}
            onClick={() => {
              setTab("invites");
              setSubtabInUrl("invites");
            }}
          >
            Invites
          </button>
        </div>
      </div>

      {currentOrg?.type === "personal" ? (
        <div className="rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
          Personal workspaces are single-user (no members to manage, no invites). Switch to an org workspace to manage members and invites.
        </div>
      ) : null}

      {tab === "members" ? (
        <div className="space-y-3">
          {isPersonalOrg ? (
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
              <div className="flex items-center justify-between gap-3 px-3 py-2 sm:px-4">
                <div className="text-[12px] font-semibold text-[var(--muted-2)]">
                  {(currentOrg?.name ?? "").trim() ? `${String(currentOrg?.name).trim()} Members` : "Members"}
                </div>
              </div>
              <div className="h-px bg-[var(--border)]" />
              {members.length ? (
                <div className="divide-y divide-[var(--border)]">
                  {members.map((m) => {
                    const label = (m.name ?? "").trim() || (m.email ?? "").trim() || "You";
                    return (
                      <div key={m.userId} className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--panel-2)] text-[11px] font-semibold text-[var(--fg)]">
                            {initials(label)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{label}</div>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted-2)]">
                              <span>{m.email ?? "—"}</span>
                              <span>{m.memberRole ?? "owner"}</span>
                            </div>
                          </div>
                        </div>
                        <div className="shrink-0">
                          <span className="text-[12px] text-[var(--muted-2)]">You</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">—</div>
              )}
            </div>
          ) : !teamsAuthResolved ? (
            <div className="rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
              Loading…
            </div>
          ) : !canAdminTeams ? (
            <div className="rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
              You don’t have permission to view members in this workspace.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
              <div className="flex items-center justify-between gap-3 px-3 py-2 sm:px-4">
                <div className="text-[12px] font-semibold text-[var(--muted-2)]">
                  {(currentOrg?.name ?? "").trim() ? `${String(currentOrg?.name).trim()} Members` : "Members"}
                </div>
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-[12px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                  disabled={membersBusy}
                  onClick={() => void loadMembers()}
                >
                  {membersBusy ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="h-px bg-[var(--border)]" />

              {membersError ? <div className="px-3 py-3 text-[12px] text-red-500 sm:px-4">{membersError}</div> : null}

              {membersBusy ? (
                <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">Loading…</div>
              ) : members.length ? (
                <div className="divide-y divide-[var(--border)]">
                  {members.map((m) => {
                    const label = (m.name ?? "").trim() || (m.email ?? "").trim() || "User";
                    const isSelf =
                      Boolean(session?.user?.email) &&
                      Boolean(m.email) &&
                      String(session?.user?.email).trim().toLowerCase() === String(m.email).trim().toLowerCase();
                    return (
                      <div key={m.userId} className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--panel-2)] text-[11px] font-semibold text-[var(--fg)]">
                            {initials(label)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{label}</div>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted-2)]">
                              <span>{m.email ?? "—"}</span>
                              <span>{m.memberRole ?? "member"}</span>
                              <span>Joined {formatDate(m.joinedAt)}</span>
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0">
                          {m.userId && !isSelf ? (
                            <button
                              type="button"
                              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)]"
                              onClick={() => void revokeMember(m.userId)}
                            >
                              Remove
                            </button>
                          ) : (
                            <span className="text-[12px] text-[var(--muted-2)]">You</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">No members yet.</div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {tab === "invites" ? (
        isPersonalOrg ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-[var(--panel-2)] px-4 py-3 text-[12px] text-[var(--muted-2)]">
              Personal workspaces can’t generate invite links. Switch to an org workspace to invite members.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[var(--fg)]">Invite links</div>
                <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
                  Invite someone to the active workspace. Links expire after 14 days.
                </div>
              </div>

              {canInvite ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                  <label className="sr-only" htmlFor="invite-role">
                    Invite role
                  </label>
                  <select
                    id="invite-role"
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)] sm:w-[180px]"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as "member" | "viewer" | "admin")}
                    disabled={inviteBusy || inviteEmailBusy}
                  >
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                    disabled={inviteBusy || inviteEmailBusy}
                    onClick={() => void createInvite()}
                  >
                    {inviteBusy ? "Generating…" : inviteLink ? "Generate new link" : "Generate link"}
                  </button>
                </div>
              ) : !teamsAuthResolved ? (
                <div className="text-[12px] text-[var(--muted-2)]">Loading…</div>
              ) : (
                <div className="text-[12px] text-[var(--muted-2)]">Only owners/admins can invite members.</div>
              )}
            </div>

            {inviteError ? <div className="text-[12px] text-red-500">{inviteError}</div> : null}

            {canInvite ? (
              <div className="rounded-xl bg-[var(--panel-2)] p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div>
                    <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Invite by email</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="name@company.com"
                      disabled={inviteEmailBusy}
                    />
                    {inviteEmailError ? <div className="mt-1 text-[12px] text-red-500">{inviteEmailError}</div> : null}
                    {inviteEmailSentTo ? (
                      <div className="mt-1 text-[12px] text-[var(--muted-2)]">Invite email sent to {inviteEmailSentTo}.</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                    disabled={inviteEmailBusy || !isValidEmail(inviteEmail)}
                    onClick={() => void sendInviteEmail()}
                  >
                    {inviteEmailBusy ? "Sending…" : "Send invite"}
                  </button>
                </div>
              </div>
            ) : null}

            {inviteLink ? (
              <div className="rounded-xl bg-[var(--panel-2)] p-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-[var(--fg)]">
                    {inviteEmailSentTo ? `Invite link (emailed to ${inviteEmailSentTo})` : "New invite link"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[var(--muted-2)]" aria-live="polite">
                    {inviteLinkCopied ? "Copied." : "Select to copy. Anyone with the link can join until it expires."}
                  </div>
                </div>
                <div className="mt-2">
                  <input
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)]"
                    value={inviteLink}
                    readOnly
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-1">
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
              </div>

              <button
                type="button"
                className="rounded-lg px-2 py-1 text-[12px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                disabled={existingInvitesBusy || !canInvite || !activeOrgId}
                onClick={() => void loadExistingInvites({ force: true })}
              >
                {existingInvitesBusy ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {existingInvitesError ? <div className="text-[12px] text-red-500">{existingInvitesError}</div> : null}

            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
              <div className="overflow-x-auto">
                <div className="min-w-[560px]">
                  <div className="grid grid-cols-[1fr_90px_90px_90px] gap-3 px-3 py-2 text-[11px] font-semibold text-[var(--muted-2)] sm:px-4">
                    <div>Link</div>
                    <div>Role</div>
                    <div>Status</div>
                    <div>Expires</div>
                  </div>
                  <div className="h-px bg-[var(--border)]" />

                  {existingInvitesBusy ? (
                    <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">Loading…</div>
                  ) : filteredInvites.length ? (
                    <div className="max-h-[420px] overflow-auto">
                      <div className="divide-y divide-[var(--border)]">
                        {filteredInvites.map((inv, idx) => {
                          const url = typeof inv.inviteUrl === "string" ? inv.inviteUrl : "";
                          const email = typeof inv.email === "string" ? inv.email : "";
                          const redeemedByLabel = (() => {
                            const rb = inv.redeemedBy;
                            if (!rb) return "";
                            const name = (rb.name ?? "").trim();
                            const em = (rb.email ?? "").trim();
                            return name || em;
                          })();
                          const { status, expiresLabel } = inviteRowMeta({
                            expiresAt: inv.expiresAt,
                            redeemedAt: inv.redeemedAt,
                          });
                          return (
                            <div
                              key={`${inv.id ?? inv.createdDate ?? "x"}:${idx}`}
                              className="grid grid-cols-[1fr_90px_90px_90px] items-center gap-3 px-3 py-2 text-[12px] text-[var(--fg)] hover:bg-[var(--panel-hover)] sm:px-4"
                            >
                              <div className="min-w-0">
                                {email ? (
                                  <div className="truncate text-[12px] font-semibold text-[var(--fg)]" title={email}>
                                    {email}
                                  </div>
                                ) : null}
                                {status === "Used" && redeemedByLabel ? (
                                  <div className="truncate text-[11px] text-[var(--muted-2)]" title={redeemedByLabel}>
                                    Used by {redeemedByLabel}
                                  </div>
                                ) : null}
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
                                  <div className="truncate text-[12px] text-[var(--muted-2)]">
                                    Legacy invite (no link saved)
                                  </div>
                                )}
                              </div>
                              <div className="truncate text-[12px] text-[var(--fg)]">{inv.role || "member"}</div>
                              <div>
                                <span className="inline-flex items-center rounded-full bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted-2)]">
                                  {status}
                                </span>
                              </div>
                              <div className="text-[12px] text-[var(--muted-2)]">{expiresLabel}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">
                      {inviteCounts.all === 0 ? "No invite links yet." : "No invite links in this view."}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}


