"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";

function clsx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function initials(name: string) {
  const s = name.trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

/**
 * Small UI pill that shows the currently active workspace (org) name.
 *
 * This is a client-only best-effort indicator. The server remains the source of truth
 * for tenancy and active-org selection.
 */
export default function ActiveWorkspacePill({
  className,
  maxWidthClassName = "max-w-[240px]",
  textClassName,
}: {
  className?: string;
  /** Tailwind max-width class for truncation control (defaults to max-w-[240px]). */
  maxWidthClassName?: string;
  /** Tailwind text sizing overrides (defaults to text-[12px]). */
  textClassName?: string;
}) {
  const { data: session } = useSession();
  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string>("");
  const [activeWorkspaceAvatarUrl, setActiveWorkspaceAvatarUrl] = useState<string | null>(null);
  const [avatarErrored, setAvatarErrored] = useState(false);

  useEffect(() => {
    setAvatarErrored(false);
  }, [activeWorkspaceAvatarUrl]);

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const hydrate = () => {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      const activeId = typeof snap.activeOrgId === "string" ? snap.activeOrgId : "";
      const org = snap.orgs?.find?.((o) => o.id === activeId);
      const label = (org?.name ?? "").trim();
      const avatarUrl = typeof (org as { avatarUrl?: unknown } | null)?.avatarUrl === "string" ? String(org?.avatarUrl) : null;
      if (!cancelled) {
        setActiveWorkspaceName(label);
        setActiveWorkspaceAvatarUrl(avatarUrl);
      }
    };

    hydrate();

    // Best-effort refresh to ensure the indicator reflects server state (cache is not a source of truth).
    void (async () => {
      try {
        await refreshOrgsCache({ userKey, force: false });
        hydrate();
      } catch {
        // ignore
      }
    })();

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    return () => {
      cancelled = true;
      window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    };
  }, [userKey]);

  if (!activeWorkspaceName) return null;

  return (
    <div
      className={clsx(
        "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 font-semibold text-[var(--fg)]",
        maxWidthClassName,
        textClassName ?? "text-[12px]",
        className,
      )}
      title={activeWorkspaceName}
      aria-label={`Active workspace: ${activeWorkspaceName}`}
    >
      <span
        className="mr-1.5 grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-[9px] font-semibold text-[var(--fg)]"
        aria-hidden="true"
      >
        {activeWorkspaceAvatarUrl && !avatarErrored ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={activeWorkspaceAvatarUrl}
            alt=""
            className="h-4 w-4 object-cover"
            onError={() => setAvatarErrored(true)}
          />
        ) : (
          <span aria-hidden="true">{initials(activeWorkspaceName)}</span>
        )}
      </span>
      <span className="truncate">{activeWorkspaceName}</span>
    </div>
  );
}


