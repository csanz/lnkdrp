"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";
import { cn } from "@/lib/cn";

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
  planBadgeText,
  textClassName,
  disableNetwork = false,
}: {
  className?: string;
  /** Tailwind max-width class for truncation control (defaults to max-w-[240px]). */
  maxWidthClassName?: string;
  /** Optional plan badge (e.g. "PRO") rendered as a right-side segment of the pill. */
  planBadgeText?: string;
  /** Tailwind text sizing overrides (defaults to text-[12px]). */
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

  return (
    <div
      className={cn(
        "inline-flex min-w-0 items-stretch overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] font-semibold text-[var(--fg)] dark:border-[color-mix(in_srgb,var(--border)_30%,transparent)]",
        maxWidthClassName,
        textClassName ?? "text-[12px]",
        className,
      )}
      title={activeWorkspaceName}
      aria-label={`Active workspace: ${activeWorkspaceName}`}
    >
      <div className="flex min-w-0 items-center px-[11px] py-[7px]">
        <span
          className="mr-1.5 grid h-[16px] w-[16px] shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-[9px] font-semibold text-[var(--fg)]"
          aria-hidden="true"
        >
          {activeWorkspaceAvatarUrl && !avatarErrored ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={activeWorkspaceAvatarUrl}
              alt=""
              className="h-[16px] w-[16px] object-cover"
              onError={() => setAvatarErrored(true)}
            />
          ) : (
            <span aria-hidden="true">{initials(activeWorkspaceName)}</span>
          )}
        </span>
        <span className="min-w-0 truncate">{activeWorkspaceName}</span>
      </div>
      {showProSegment ? (
        <div
          className="inline-flex shrink-0 items-center border-l border-[var(--border)] bg-[var(--panel-2)] px-3 py-[7px] text-[9px] font-medium tracking-[0.07em] text-[var(--muted-2)] dark:border-[color-mix(in_srgb,var(--border)_30%,transparent)] dark:bg-[color-mix(in_srgb,var(--panel)_85%,black)] dark:text-[color-mix(in_srgb,var(--fg)_70%,var(--bg))]"
          aria-label={`${badgeText} plan`}
          title={`${badgeText} plan`}
        >
          {badgeText}
        </div>
      ) : null}
    </div>
  );
}


