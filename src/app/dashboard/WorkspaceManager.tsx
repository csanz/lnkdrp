/**
 * Workspace manager for `/dashboard?tab=workspace` — org list/switch + org creation + workspace settings.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { fetchJson } from "@/lib/http/fetchJson";
import { clearSidebarCache, setActiveOrgIdForCaches } from "@/lib/sidebarCache";
import {
  ORGS_CACHE_UPDATED_EVENT,
  readOrgsCacheSnapshot,
  refreshOrgsCache,
  setCachedActiveOrgId,
} from "@/lib/orgsCache";
import { useNavigationLocked } from "@/app/providers";
import Modal from "@/components/modals/Modal";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildOrgAvatarPathname } from "@/lib/blob/clientUpload";

function initials(nameOrEmail: string) {
  const s = nameOrEmail.trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

async function readImageDims(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error("Failed to read image"));
      img.src = url;
    });
    return dims;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--muted-2)]">
      {children}
    </span>
  );
}

type OrgRow = { id: string; name: string; type: string; role: string; avatarUrl?: string | null };

export default function WorkspaceManager() {
  const { data: session } = useSession();
  const navLocked = useNavigationLocked();

  const [orgsBusy, setOrgsBusy] = useState(false);
  const [orgActionBusy, setOrgActionBusy] = useState(false);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [serverActiveOrgId, setServerActiveOrgId] = useState<string | null>(null);

  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [showManageOrgModal, setShowManageOrgModal] = useState(false);
  const [manageOrgId, setManageOrgId] = useState<string>("");
  const [countsBusy, setCountsBusy] = useState(false);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [manageCounts, setManageCounts] = useState<{
    members: number;
    docs: number;
    projects: number;
    uploads: number;
    invites: number;
  } | null>(null);
  const [manageOrgName, setManageOrgName] = useState<string>("");
  const [manageOrgAvatarUrl, setManageOrgAvatarUrl] = useState<string>("");
  const [baselineOrgName, setBaselineOrgName] = useState<string>("");
  const [baselineOrgAvatarUrl, setBaselineOrgAvatarUrl] = useState<string>("");
  const [manageRenameError, setManageRenameError] = useState<string | null>(null);
  const [manageAvatarError, setManageAvatarError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState<string>("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const [createOrgName, setCreateOrgName] = useState("");
  const [createOrgError, setCreateOrgError] = useState<string | null>(null);

  // Prefer the server-reported active org (it is the source of truth), fall back to session.
  const activeOrgId = serverActiveOrgId ?? (session as any)?.activeOrgId ?? null;

  // Ensure stable ordering even if older cached data was written when the server sorted active-first.
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

  const activeRow = useMemo(() => {
    if (!activeOrgId) return null;
    return stableOrgs.find((o) => o.id === activeOrgId) ?? null;
  }, [stableOrgs, activeOrgId]);

  const otherRows = useMemo(() => {
    if (!activeOrgId) return stableOrgs;
    return stableOrgs.filter((o) => o.id !== activeOrgId);
  }, [stableOrgs, activeOrgId]);
  const manageOrgRow = useMemo(() => {
    if (!manageOrgId) return null;
    return stableOrgs.find((o) => o.id === manageOrgId) ?? null;
  }, [manageOrgId, stableOrgs]);

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
        const snap = await refreshOrgsCache({ userKey, force: true });
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
          setOrgsError(e instanceof Error ? e.message : "Failed to load orgs");
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

  const switchOrg = useCallback(
    async (nextOrgId: string) => {
      if (!nextOrgId) return;
      if (!session?.user) return;
      if (navLocked) return;
      if (orgActionBusy) return;
      setOrgActionBusy(true);
      try {
        setCachedActiveOrgId(nextOrgId, session.user.email ?? "");
        setActiveOrgIdForCaches(nextOrgId);
        clearSidebarCache({ memoryOnly: true });
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
        setCachedActiveOrgId(newOrgId, session.user.email ?? "");
        setActiveOrgIdForCaches(newOrgId);
        clearSidebarCache({ memoryOnly: true });
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
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
    } catch (e) {
      setCreateOrgError(e instanceof Error ? e.message : "Failed to create org");
    } finally {
      setOrgActionBusy(false);
    }
  }, [session?.user, navLocked, orgActionBusy, createOrgName]);

  const openManageOrg = useCallback(
    async (orgId: string) => {
      if (!session?.user) return;
      if (!orgId) return;
      if (navLocked) return;
      setManageOrgId(orgId);
      setShowManageOrgModal(true);
      setManageCounts(null);
      setCountsBusy(false);
      setCountsError(null);
      setManageRenameError(null);
      setManageAvatarError(null);
      setLeaveError(null);
      setDeleteError(null);
      setDeleteConfirmText("");
      setShowDeleteConfirm(false);
      setSavingName(false);
      setSavingAvatar(false);
      setUploadingAvatar(false);
      // Instant render: seed from cached org list; avoid network on open.
      const cachedRow = stableOrgs.find((o) => o.id === orgId) ?? null;
      if (cachedRow) {
        const name = cachedRow.name ?? "";
        const avatar = typeof cachedRow.avatarUrl === "string" ? cachedRow.avatarUrl : "";
        setManageOrgName(name);
        setManageOrgAvatarUrl(avatar);
        setBaselineOrgName(name.trim());
        setBaselineOrgAvatarUrl(avatar.trim());
      } else {
        setManageOrgName("");
        setManageOrgAvatarUrl("");
        setBaselineOrgName("");
        setBaselineOrgAvatarUrl("");
      }
    },
    [session?.user, navLocked, stableOrgs],
  );

  const loadManageCounts = useCallback(async () => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (manageCounts) return;
    setCountsBusy(true);
    setCountsError(null);
    try {
      const json = await fetchJson<{
        counts?: { members: number; docs: number; projects: number; uploads: number; invites: number } | null;
      }>(`/api/orgs/${encodeURIComponent(manageOrgId)}?includeCounts=1`, { method: "GET" });
      setManageCounts(json?.counts && typeof (json.counts as any).members === "number" ? (json.counts as any) : null);
    } catch (e) {
      setCountsError(e instanceof Error ? e.message : "Failed to load workspace counts");
    } finally {
      setCountsBusy(false);
    }
  }, [session?.user, manageOrgId, navLocked, manageCounts]);

  const saveOrgName = useCallback(async () => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    const name = manageOrgName.trim();
    if (!name) {
      setManageRenameError("Name is required");
      return;
    }
    setOrgActionBusy(true);
    setSavingName(true);
    setManageRenameError(null);
    try {
      await fetchJson(`/api/orgs/${encodeURIComponent(manageOrgId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setBaselineOrgName(name);
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
    } catch (e) {
      setManageRenameError(e instanceof Error ? e.message : "Failed to rename workspace");
    } finally {
      setSavingName(false);
      setOrgActionBusy(false);
    }
  }, [session?.user, manageOrgId, navLocked, orgActionBusy, manageOrgName]);

  const saveAvatarUrl = useCallback(async () => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    const raw = manageOrgAvatarUrl.trim();
    const avatarUrl = raw ? raw : null;
    if (avatarUrl && !avatarUrl.startsWith("https://")) {
      setManageAvatarError("Avatar URL must start with https://");
      return;
    }
    setOrgActionBusy(true);
    setSavingAvatar(true);
    setManageAvatarError(null);
    try {
      await fetchJson(`/api/orgs/${encodeURIComponent(manageOrgId)}/avatar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avatarUrl }),
      });
      setBaselineOrgAvatarUrl((avatarUrl ?? "").trim());
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
    } catch (e) {
      setManageAvatarError(e instanceof Error ? e.message : "Failed to update avatar");
    } finally {
      setSavingAvatar(false);
      setOrgActionBusy(false);
    }
  }, [session?.user, manageOrgId, navLocked, orgActionBusy, manageOrgAvatarUrl]);

  const uploadAvatarFile = useCallback(
    async (file: File) => {
      if (!session?.user) return;
      if (!manageOrgId) return;
      if (navLocked) return;
      if (orgActionBusy) return;
      if (!file) return;
      setOrgActionBusy(true);
      setUploadingAvatar(true);
      setManageAvatarError(null);
      try {
        // Workspace icon requirements:
        // - Square (1:1)
        // - At least 120×120
        // - PNG/JPG/WebP
        // - Reasonable file size (keep the UI snappy)
        const type = String(file.type || "").toLowerCase();
        const okType = type === "image/png" || type === "image/jpeg" || type === "image/webp";
        if (!okType) {
          throw new Error("Please upload a PNG, JPG, or WebP image.");
        }
        const maxBytes = 2 * 1024 * 1024;
        if (file.size > maxBytes) {
          throw new Error("Please upload an image ≤ 2MB.");
        }
        const { width, height } = await readImageDims(file);
        if (!width || !height) throw new Error("Invalid image.");
        if (width !== height) {
          throw new Error("Workspace icons must be square (1:1 aspect ratio).");
        }
        if (width < 120 || height < 120) {
          throw new Error("Workspace icons must be at least 120×120.");
        }

        const pathname = buildOrgAvatarPathname({ orgId: manageOrgId, fileName: file.name });
        const blob = await blobUpload(pathname, file, {
          access: "public",
          handleUploadUrl: BLOB_HANDLE_UPLOAD_URL,
        });
        const url = typeof (blob as any)?.url === "string" ? String((blob as any).url) : "";
        if (!url) throw new Error("Failed to upload avatar");
        setManageOrgAvatarUrl(url);
        await fetchJson(`/api/orgs/${encodeURIComponent(manageOrgId)}/avatar`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ avatarUrl: url }),
        });
        setBaselineOrgAvatarUrl(url.trim());
        await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
      } catch (e) {
        setManageAvatarError(e instanceof Error ? e.message : "Failed to upload avatar");
      } finally {
        setUploadingAvatar(false);
        setOrgActionBusy(false);
      }
    },
    [session?.user, manageOrgId, navLocked, orgActionBusy],
  );

  const leaveOrg = useCallback(async () => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    const ok = window.confirm("Leave this workspace? You’ll lose access immediately.");
    if (!ok) return;
    setOrgActionBusy(true);
    setLeaveError(null);
    try {
      await fetchJson(`/api/orgs/${encodeURIComponent(manageOrgId)}/leave`, { method: "POST" });
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
      window.location.reload();
    } catch (e) {
      setLeaveError(e instanceof Error ? e.message : "Failed to leave workspace");
    } finally {
      setOrgActionBusy(false);
    }
  }, [session?.user, manageOrgId, navLocked, orgActionBusy]);

  const deleteOrg = useCallback(async () => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    setOrgActionBusy(true);
    setDeleteError(null);
    try {
      await fetchJson(`/api/orgs/${encodeURIComponent(manageOrgId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: deleteConfirmText }),
      });
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
      window.location.reload();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete workspace");
    } finally {
      setOrgActionBusy(false);
    }
  }, [session?.user, manageOrgId, navLocked, orgActionBusy, deleteConfirmText]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
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
            onClick={() => {
              setCreateOrgError(null);
              setCreateOrgName("");
              setShowCreateOrgModal(true);
            }}
          >
            Create workspace…
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl bg-[var(--panel)]">
        <div className="grid grid-cols-[1fr_110px_140px] gap-3 px-3 py-2 text-[11px] font-semibold text-[var(--muted-2)] sm:px-4">
          <div>Workspace</div>
          <div>Role</div>
          <div className="text-right">Actions</div>
        </div>
        <div className="h-px bg-[var(--border)]" />

        {orgsError ? <div className="px-3 py-3 text-[12px] text-red-500 sm:px-4">{orgsError}</div> : null}
        {orgsBusy ? (
          <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">Loading…</div>
        ) : stableOrgs.length ? (
          <div className="divide-y divide-[var(--border)]">
            {activeRow ? (
              <div className="bg-[var(--panel-2)]">
                <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)] sm:px-4">
                  Active
                </div>
                <div className="px-3 pb-3 sm:px-4">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {activeRow.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={activeRow.avatarUrl}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded-lg border border-[var(--border)] object-cover"
                        />
                      ) : (
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--panel-2)] text-[11px] font-semibold text-[var(--fg)]">
                          {initials((activeRow.name ?? "").trim() || "Workspace")}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{activeRow.name}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                          {activeRow.type === "personal" ? "Personal" : "Org"} • Active
                        </div>
                      </div>
                    </div>

                    <div className="w-[110px] text-[12px] text-[var(--muted-2)]">{activeRow.role}</div>

                    <div className="flex w-[140px] justify-end gap-2">
                      {activeRow.role === "owner" || activeRow.role === "admin" ? (
                        <button
                          type="button"
                          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                          disabled={navLocked || orgActionBusy}
                          onClick={() => void openManageOrg(activeRow.id)}
                        >
                          Manage…
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="rounded-lg bg-[var(--panel-hover)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)]"
                        disabled
                        title="Current workspace"
                      >
                        Active
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {otherRows.length ? (
              <div>
                <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)] sm:px-4">
                  Other workspaces
                </div>
                {otherRows.map((o) => {
                  const isActive = false;
                  const avatarLabel = (o.name ?? "").trim() || "Workspace";
                  return (
                    <div key={o.id} className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {o.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={o.avatarUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-lg border border-[var(--border)] object-cover"
                      />
                    ) : (
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--panel-2)] text-[11px] font-semibold text-[var(--fg)]">
                        {initials(avatarLabel)}
              </div>
            )}
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{o.name}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                        {o.type === "personal" ? "Personal" : "Org"}
          </div>
        </div>
          </div>

                  <div className="w-[110px] text-[12px] text-[var(--muted-2)]">{o.role}</div>

                  <div className="flex w-[140px] justify-end gap-2">
                    {o.role === "owner" || o.role === "admin" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                        disabled={navLocked || orgActionBusy}
                        onClick={() => void openManageOrg(o.id)}
                      >
                        Manage…
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                      disabled={navLocked || orgActionBusy}
                      onClick={() => void switchOrg(o.id)}
                      title="Switch workspace"
                    >
                      Switch
                    </button>
                  </div>
                </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="px-3 py-3 text-[12px] text-[var(--muted-2)] sm:px-4">No workspaces.</div>
        )}
                  </div>

      <Modal
        open={showManageOrgModal}
        onClose={() => setShowManageOrgModal(false)}
        ariaLabel="Manage workspace"
        // Keep the modal centered (matches the rest of the app) and widen slightly for form layouts.
        panelClassName="w-[min(720px,calc(100vw-32px))]"
      >
        <div>
                        <div className="min-w-0">
            <div className="text-base font-semibold text-[var(--fg)]">Manage workspace</div>
            <div className="mt-1 truncate text-[12px] text-[var(--muted-2)]">{manageOrgName || "—"}</div>
                        </div>

          {/**
           * Change tracking (so Save buttons only enable when there are unsaved changes).
           */}
          {(() => {
            const nameDirty = manageOrgName.trim() !== baselineOrgName;
            const avatarDirty = manageOrgAvatarUrl.trim() !== baselineOrgAvatarUrl;
            const avatarUrlOk =
              !manageOrgAvatarUrl.trim() || manageOrgAvatarUrl.trim().startsWith("https://");
            return (
              <div className="mt-6 space-y-7">
          <div>
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Name</div>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                value={manageOrgName}
                onChange={(e) => setManageOrgName(e.target.value)}
                disabled={orgActionBusy || savingName}
              />
              <button
                              type="button"
                className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                disabled={orgActionBusy || savingName || !manageOrgName.trim() || !nameDirty}
                onClick={() => void saveOrgName()}
                title={!nameDirty ? "No changes" : undefined}
              >
                {savingName ? "Saving…" : "Save"}
                            </button>
                        </div>
            {manageRenameError ? <div className="mt-2 text-[12px] text-red-500">{manageRenameError}</div> : null}
                      </div>

          <div>
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Avatar</div>
            <div className="mt-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)] sm:flex-1"
                  value={manageOrgAvatarUrl}
                  onChange={(e) => setManageOrgAvatarUrl(e.target.value)}
                  placeholder="https://…"
                  disabled={orgActionBusy || savingAvatar || uploadingAvatar}
                />
                <div className="flex shrink-0 justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                    disabled={orgActionBusy || savingAvatar || uploadingAvatar}
                    onClick={() => {
                      setManageOrgAvatarUrl("");
                      void saveAvatarUrl();
                    }}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                    disabled={
                      orgActionBusy ||
                      savingAvatar ||
                      uploadingAvatar ||
                      !avatarDirty ||
                      !avatarUrlOk
                    }
                    onClick={() => void saveAvatarUrl()}
                    title={!avatarDirty ? "No changes" : !avatarUrlOk ? "URL must start with https://" : undefined}
                  >
                    {savingAvatar ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <div className="mt-1 text-[11px] text-[var(--muted-2)]">
                Workspace icon: square (1:1), at least <span className="font-semibold">120×120</span>, PNG/JPG/WebP, ≤ 2MB.
              </div>
            </div>
            <div className="mt-2">
              <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Upload image</label>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="mt-1 block w-full text-[12px] text-[var(--muted-2)]"
                disabled={orgActionBusy || uploadingAvatar}
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) void uploadAvatarFile(f);
                  e.currentTarget.value = "";
                }}
              />
              <div className="mt-1 text-[11px] text-[var(--muted-2)]">
                {uploadingAvatar ? "Uploading… (updates automatically)" : "Uploads update the workspace icon automatically."}
              </div>
            </div>
            {manageAvatarError ? <div className="mt-2 text-[12px] text-red-500">{manageAvatarError}</div> : null}
          </div>

          <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-5">
            <div className="text-[13px] font-semibold text-[var(--fg)]">Danger zone</div>
            {manageCounts ? (
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                This workspace contains {manageCounts.members} member(s), {manageCounts.projects} project(s), {manageCounts.docs} doc(s), and{" "}
                {manageCounts.uploads} upload(s).
              </div>
            ) : countsBusy ? (
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">Loading workspace counts…</div>
            ) : countsError ? (
              <div className="mt-2 text-[12px] text-red-500">{countsError}</div>
            ) : (
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">Be careful—these actions are hard to undo.</div>
            )}

            {leaveError ? <div className="mt-2 text-[12px] text-red-500">{leaveError}</div> : null}

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[12px] text-[var(--muted-2)]">Leave workspace (non-owners only)</div>
              <button
                type="button"
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                disabled={orgActionBusy || !manageOrgRow || manageOrgRow.type === "personal" || manageOrgRow.role === "owner"}
                onClick={() => void leaveOrg()}
                title={manageOrgRow?.role === "owner" ? "Owners can’t leave; delete the workspace instead." : "Leave workspace"}
              >
                Leave
              </button>
            </div>

            <div className="mt-3">
              {!showDeleteConfirm ? (
                <button
                  type="button"
                  className="rounded-lg bg-red-600 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
                  disabled={orgActionBusy || !manageOrgId}
                  onClick={() => {
                    setShowDeleteConfirm(true);
                    void loadManageCounts();
                  }}
                >
                  Delete workspace…
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="text-[12px] font-semibold text-[var(--fg)]">Confirm deletion</div>
                  <div className="text-[12px] text-[var(--muted-2)]">
                    Type <span className="font-semibold">delete {manageOrgName}</span> to permanently delete this workspace and its content.
                  </div>
                  <input
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={`delete ${manageOrgName}`}
                    disabled={orgActionBusy}
                  />
                  {deleteError ? <div className="text-[12px] text-red-500">{deleteError}</div> : null}
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-lg px-3 py-2 text-[13px] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] disabled:opacity-60"
                      disabled={orgActionBusy}
                      onClick={() => {
                        setShowDeleteConfirm(false);
                        setDeleteConfirmText("");
                        setDeleteError(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-lg bg-red-600 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
                      disabled={orgActionBusy || !deleteConfirmText.trim()}
                      onClick={() => void deleteOrg()}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
            );
          })()}
        </div>
      </Modal>

      <Modal open={showCreateOrgModal} onClose={() => setShowCreateOrgModal(false)} ariaLabel="Create workspace">
        <div className="text-base font-semibold text-[var(--fg)]">Create workspace</div>
        <div className="mt-1 text-[12px] text-[var(--muted-2)]">
          A workspace can be a diff group within your own organization, a separate project group, or a completely new company.
        </div>
        <div className="mt-4">
          <label className="block text-[12px] font-semibold text-[var(--muted-2)]">Workspace name</label>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
            value={createOrgName}
            onChange={(e) => setCreateOrgName(e.target.value)}
            placeholder="Acme"
            disabled={orgActionBusy}
          />
          {createOrgError ? <div className="mt-2 text-[12px] text-red-500">{createOrgError}</div> : null}
          <div className="mt-4 flex items-center justify-end gap-2">
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
    </div>
  );
}


