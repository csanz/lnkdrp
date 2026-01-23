"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";
import WorkspacePill from "@/components/WorkspacePill";
import { initialsFromNameOrEmail } from "@/lib/format/initials";

const initials = initialsFromNameOrEmail;

/**
 * Small UI pill that shows the currently active workspace (org) name.
 *
 * This is a client-only best-effort indicator. The server remains the source of truth
 * for tenancy and active-org selection.
 */
export default function ActiveWorkspacePill({
  className,
  maxWidthClassName = "max-w-[240px]",
  planBadgeText,
  textClassName,
  disableNetwork = false,
}: {
  className?: string;
  /** Tailwind max-width class for truncation control (defaults to max-w-[240px]). */
  maxWidthClassName?: string;
  /** Optional plan badge (e.g. "PRO") rendered as a right-side segment of the pill. */
  planBadgeText?: string;
  /** Tailwind text sizing overrides (defaults to text-[13px]). */
  textClassName?: string;
  /** If true, avoid immediate network calls on mount (header fast-path); refreshes may be deferred. */
  disableNetwork?: boolean;
}) {
  const { data: session } = useSession();
  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string>("");
  const [activeWorkspaceAvatarUrl, setActiveWorkspaceAvatarUrl] = useState<string | null>(null);
  const [avatarErrored, setAvatarErrored] = useState(false);
  const [isPro, setIsPro] = useState<boolean>(false);

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

    const scheduleRefresh =
      typeof window !== "undefined" && disableNetwork
        ? window.setTimeout
        : null;

    const kick = () => {
      // Best-effort refresh to ensure the indicator reflects server state (cache is not a source of truth).
      void (async () => {
        try {
          await refreshOrgsCache({ userKey, force: false });
          hydrate();
        } catch {
          // ignore
        }
      })();
    };

    if (!disableNetwork) {
      kick();
    } else if (scheduleRefresh) {
      // Defer refresh so initial paint isn't blocked by network.
      const id = window.setTimeout(kick, 250);
      // Keep cancel behavior consistent.
      void id;
    }

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    return () => {
      cancelled = true;
      window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, hydrate);
    };
  }, [userKey, disableNetwork]);

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const cacheKey = `lnkdrp_billing_plan_${userKey}`;
    const cachedPlan = typeof window !== "undefined" ? window.sessionStorage.getItem(cacheKey) : null;
    if (cachedPlan === "pro") setIsPro(true);
    if (cachedPlan === "free") setIsPro(false);

    if (disableNetwork) {
      // Defer background refresh so initial paint isn't blocked by network.
      const id = typeof window !== "undefined" ? window.setTimeout(async () => {
        try {
          const res = await fetch("/api/billing/status", { method: "GET" });
          const json = (await res.json().catch(() => null)) as { plan?: string } | { error?: string } | null;
          if (!res.ok) return;
          const plan = typeof (json as any)?.plan === "string" ? String((json as any).plan).trim() : "";
          const nextIsPro = plan === "pro";
          if (typeof window !== "undefined") window.sessionStorage.setItem(cacheKey, nextIsPro ? "pro" : "free");
          if (!cancelled) setIsPro(nextIsPro);
        } catch {
          // ignore (best-effort)
        }
      }, 350) : null;
      return () => {
        cancelled = true;
        if (id != null) window.clearTimeout(id);
      };
    }

    void (async () => {
      try {
        const res = await fetch("/api/billing/status", { method: "GET" });
        const json = (await res.json().catch(() => null)) as { plan?: string } | { error?: string } | null;
        if (!res.ok) return;
        const plan = typeof (json as any)?.plan === "string" ? String((json as any).plan).trim() : "";
        const nextIsPro = plan === "pro";
        if (typeof window !== "undefined") window.sessionStorage.setItem(cacheKey, nextIsPro ? "pro" : "free");
        if (!cancelled) setIsPro(nextIsPro);
      } catch {
        // ignore (best-effort)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userKey, disableNetwork]);

  if (!activeWorkspaceName) return null;

  const badgeText = (planBadgeText ?? "PRO").trim();
  const showProSegment = isPro && !!badgeText;

  // When authenticated, clicking the workspace pill should jump to Dashboard → Workspace.
  // (This keeps the "app shell" clean while still providing an obvious route to workspace settings.)
  const href = session?.user ? "/dashboard?tab=workspace" : undefined;

  return (
    <WorkspacePill
      href={href}
      title={activeWorkspaceName}
      ariaLabel={`Active workspace: ${activeWorkspaceName}`}
      className={className}
      maxWidthClassName={maxWidthClassName}
      textClassName={textClassName}
      name={activeWorkspaceName}
      avatarUrl={activeWorkspaceAvatarUrl}
      avatarFallbackText={initials(activeWorkspaceName)}
      avatarErrored={avatarErrored}
      onAvatarError={() => setAvatarErrored(true)}
      showBadge={showProSegment}
      badgeText={badgeText}
    />
  );
}


