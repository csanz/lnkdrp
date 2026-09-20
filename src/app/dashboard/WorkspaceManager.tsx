/**
 * Workspace manager for `/dashboard?tab=workspace` — org list/switch + org creation + workspace settings.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/http/fetchJson";
import { refreshOrgsCache } from "@/lib/orgsCache";
import { useNavigationLocked } from "@/app/providers";
import Modal from "@/components/modals/Modal";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";
import { upload as blobUpload } from "@vercel/blob/client";
import { BLOB_HANDLE_UPLOAD_URL, buildOrgAvatarPathname } from "@/lib/blob/clientUpload";
import WorkspaceIcon from "@/components/WorkspaceIcon";
import Pill from "@/components/ui/Pill";
import { initials } from "@/lib/orgs/orgsClient";
import { useOrgsSnapshot } from "@/lib/orgs/useOrgsSnapshot";

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

/**
 * Crops transparent margins off a logo and squares it, so the mark fills its tile.
 *
 * Exported logos often carry a wide transparent border (USAVX's 400×400 PNG drew its mark in the
 * middle 214px), which CSS cannot remove: the icon then looked heavily padded at every size.
 * Returns the original file when there is nothing to trim (opaque images such as JPGs included).
 */
async function trimTransparentMargins(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to read image"));
      img.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return file; // fully transparent; let the upload fail or show as-is
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Under 3% margin on every side is not worth re-encoding.
    if (bw >= w * 0.94 && bh >= h * 0.94) return file;
    const side = Math.max(bw, bh);
    const out = document.createElement("canvas");
    out.width = side;
    out.height = side;
    const octx = out.getContext("2d");
    if (!octx) return file;
    octx.drawImage(canvas, minX, minY, bw, bh, Math.round((side - bw) / 2), Math.round((side - bh) / 2), bw, bh);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
    if (!blob) return file;
    const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "icon";
    return new File([blob], `${base}.png`, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function WorkspaceManager() {
  const { session, stableOrgs, activeOrgId, orgsBusy, orgsError } = useOrgsSnapshot();
  const navLocked = useNavigationLocked();

  const [orgActionBusy, setOrgActionBusy] = useState(false);

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
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [avatarUrlOpen, setAvatarUrlOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState<string>("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const [createOrgName, setCreateOrgName] = useState("");
  const [createOrgError, setCreateOrgError] = useState<string | null>(null);

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
      setCreateOrgError("Workspace name is required");
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
      await refreshOrgsCache({ userKey: session.user.email ?? "", force: true }).catch(() => void 0);
    } catch (e) {
      setCreateOrgError(e instanceof Error ? e.message : "Failed to create workspace");
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
      setAvatarDragOver(false);
      setAvatarUrlOpen(false);
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

  /** Saves the URL field, or `override` when given ("" removes the icon; the field's state is not yet updated then). */
  const saveAvatarUrl = useCallback(async (override?: string) => {
    if (!session?.user) return;
    if (!manageOrgId) return;
    if (navLocked) return;
    if (orgActionBusy) return;
    const raw = (override ?? manageOrgAvatarUrl).trim();
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

        const trimmed = await trimTransparentMargins(file);
        const pathname = buildOrgAvatarPathname({ orgId: manageOrgId, fileName: trimmed.name });
        const blob = await blobUpload(pathname, trimmed, {
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
            {currentOrg?.type ? <Pill>{currentOrg.type === "personal" ? "Personal" : "Shared"}</Pill> : null}
            {currentOrg?.role ? <Pill><span className="capitalize">{currentOrg.role}</span></Pill> : null}
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

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <div className="overflow-x-auto">
          <div className="min-w-[520px]">
            <div className="grid grid-cols-[1fr_110px_180px] gap-3 px-3 py-2 text-[11px] font-semibold text-[var(--muted-2)] sm:px-4">
              <div>Workspace</div>
              <div>Role</div>
              <div className="text-right">Actions</div>
            </div>
            <div className="h-px bg-[var(--border)]" />

            {orgsError ? <div className="px-3 py-3 text-[12px] text-red-600 dark:text-red-500 sm:px-4">{orgsError}</div> : null}
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
                      <div className="grid grid-cols-[1fr_110px_180px] items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <WorkspaceIcon
                            avatarUrl={activeRow.avatarUrl}
                            fallback={initials((activeRow.name ?? "").trim() || "Workspace")}
                            className="h-9 w-9"
                            fallbackClassName="bg-[var(--panel-2)] text-[11px] text-[var(--fg)]"
                          />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{activeRow.name}</div>
                            <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                              {activeRow.type === "personal" ? "Personal" : "Shared"} • Active
                            </div>
                          </div>
                        </div>

                        <div className="capitalize text-[12px] text-[var(--muted-2)]">{activeRow.role}</div>

                        <div className="flex justify-end gap-2">
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
                        <div key={o.id} className="grid grid-cols-[1fr_110px_180px] items-center gap-3 px-3 py-3 sm:px-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <WorkspaceIcon
                              avatarUrl={o.avatarUrl}
                              fallback={initials(avatarLabel)}
                              className="h-8 w-8"
                              fallbackClassName="bg-[var(--panel-2)] text-[11px] text-[var(--fg)]"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{o.name}</div>
                              <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
                                {o.type === "personal" ? "Personal" : "Shared"}
                              </div>
                            </div>
                          </div>

                          <div className="capitalize text-[12px] text-[var(--muted-2)]">{o.role}</div>

                          <div className="flex justify-end gap-2">
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
        </div>
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
            {manageRenameError ? <div className="mt-2 text-[12px] text-red-600 dark:text-red-500">{manageRenameError}</div> : null}
                      </div>

          <div>
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Icon</div>
            {/*
              Drop zone + preview. This was a URL field with a bare browser file input under it
              ("Choose File No file chosen"), which read as a text line rather than a way to upload,
              and took no drops. The preview shows the icon on the black tile it gets everywhere.
            */}
            <div className="mt-2 flex items-stretch gap-3">
              <WorkspaceIcon
                avatarUrl={baselineOrgAvatarUrl || null}
                fallback={initials(manageOrgName.trim() || "Workspace")}
                className="h-[88px] w-[88px]"
                fallbackClassName="bg-[var(--panel-2)] text-[20px] text-[var(--fg)]"
              />
              <label
                className={[
                  "flex min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-xl border border-dashed px-4 py-3 transition-colors",
                  "focus-within:ring-2 focus-within:ring-[var(--muted-2)]",
                  avatarDragOver
                    ? "border-[var(--fg)] bg-[var(--panel-hover)]"
                    : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)]",
                  orgActionBusy || uploadingAvatar ? "pointer-events-none opacity-60" : "",
                ].join(" ")}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!avatarDragOver) setAvatarDragOver(true);
                }}
                onDragLeave={() => setAvatarDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setAvatarDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void uploadAvatarFile(f);
                }}
              >
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={orgActionBusy || uploadingAvatar}
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) void uploadAvatarFile(f);
                    e.currentTarget.value = "";
                  }}
                />
                <span className="text-[13px] font-semibold text-[var(--fg)]">
                  {uploadingAvatar ? "Uploading…" : avatarDragOver ? "Drop to upload" : "Drop your logo here, or choose a file"}
                </span>
                <span className="mt-1 text-[12px] leading-snug text-[var(--muted-2)]">
                  Use a <span className="font-semibold text-[var(--fg)]">white logo</span> on a transparent background. It sits on a
                  black tile in light and dark themes.
                </span>
                <span className="mt-1 text-[11px] text-[var(--muted-2)]">Square, at least 120×120. PNG or WebP (JPG works without transparency), up to 2MB. Empty transparent edges are trimmed.</span>
              </label>
            </div>
            {manageAvatarError ? <div className="mt-2 text-[12px] text-red-600 dark:text-red-500">{manageAvatarError}</div> : null}

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {baselineOrgAvatarUrl ? (
                <button
                  type="button"
                  className="text-[12px] font-semibold text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline disabled:opacity-60"
                  disabled={orgActionBusy || savingAvatar || uploadingAvatar}
                  onClick={() => {
                    setManageOrgAvatarUrl("");
                    void saveAvatarUrl("");
                  }}
                >
                  Remove icon
                </button>
              ) : null}
              <button
                type="button"
                className="text-[12px] font-semibold text-[var(--muted-2)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
                aria-expanded={avatarUrlOpen}
                onClick={() => setAvatarUrlOpen((v) => !v)}
              >
                {avatarUrlOpen ? "Hide image URL" : "Use an image URL instead"}
              </button>
            </div>

            {avatarUrlOpen ? (
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)] sm:flex-1"
                  value={manageOrgAvatarUrl}
                  onChange={(e) => setManageOrgAvatarUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="Icon image URL"
                  disabled={orgActionBusy || savingAvatar || uploadingAvatar}
                />
                <button
                  type="button"
                  className="shrink-0 rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] disabled:opacity-60"
                  disabled={orgActionBusy || savingAvatar || uploadingAvatar || !avatarDirty || !avatarUrlOk}
                  onClick={() => void saveAvatarUrl()}
                  title={!avatarDirty ? "No changes" : !avatarUrlOk ? "URL must start with https://" : undefined}
                >
                  {savingAvatar ? "Saving…" : "Save"}
                </button>
              </div>
            ) : null}
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
              <div className="mt-2 text-[12px] text-red-600 dark:text-red-500">{countsError}</div>
            ) : (
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">Be careful—these actions are hard to undo.</div>
            )}

            {leaveError ? <div className="mt-2 text-[12px] text-red-600 dark:text-red-500">{leaveError}</div> : null}

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
                  disabled={orgActionBusy || !manageOrgId || manageOrgRow?.role !== "owner"}
                  title={
                    manageOrgRow && manageOrgRow.role !== "owner"
                      ? "Only the workspace owner can delete it."
                      : "Delete workspace"
                  }
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
                    {/* `baselineOrgName`, not the live input: the server compares the typed phrase
                        against the name it has stored, so an unsaved edit in the Name field above
                        would ask for a phrase that can never match. */}
                    Type <span className="font-semibold">delete {baselineOrgName}</span> to permanently delete this workspace and its content.
                  </div>
                  <input
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none focus:border-[var(--muted-2)]"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={`delete ${baselineOrgName}`}
                    disabled={orgActionBusy}
                  />
                  {deleteError ? <div className="text-[12px] text-red-600 dark:text-red-500">{deleteError}</div> : null}
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
          A workspace can be a different group within your own organization, a separate project group, or a completely new company.
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
          {createOrgError ? <div className="mt-2 text-[12px] text-red-600 dark:text-red-500">{createOrgError}</div> : null}
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


