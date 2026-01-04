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
}: {
  className?: string;
  /** Tailwind max-width class for truncation control (defaults to max-w-[240px]). */
  maxWidthClassName?: string;
  /** Optional plan badge (e.g. "PRO") rendered to the right of the workspace name. */
  planBadgeText?: string;
  /** Tailwind text sizing overrides (defaults to text-[12px]). */
  textClassName?: string;
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

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const cacheKey = `lnkdrp_billing_plan_${userKey}`;
    const cachedPlan = typeof window !== "undefined" ? window.sessionStorage.getItem(cacheKey) : null;
    if (cachedPlan === "pro") setIsPro(true);
    if (cachedPlan === "free") setIsPro(false);

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
  }, [userKey]);

  if (!activeWorkspaceName) return null;

  const badgeText = (planBadgeText ?? "PRO").trim();

  return (
    <div
      className={cn(
        "inline-flex min-w-0 items-center rounded-lg border border-[color-mix(in_srgb,var(--border)_30%,transparent)] bg-[var(--panel)] px-[10px] py-[6px] font-semibold text-[var(--fg)]",
        maxWidthClassName,
        textClassName ?? "text-[11.5px]",
        className,
      )}
      title={activeWorkspaceName}
      aria-label={`Active workspace: ${activeWorkspaceName}`}
    >
      <span
        className="mr-1.5 grid h-[15px] w-[15px] shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-[8.5px] font-semibold text-[var(--fg)]"
        aria-hidden="true"
      >
        {activeWorkspaceAvatarUrl && !avatarErrored ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={activeWorkspaceAvatarUrl}
            alt=""
            className="h-[15px] w-[15px] object-cover"
            onError={() => setAvatarErrored(true)}
          />
        ) : (
          <span aria-hidden="true">{initials(activeWorkspaceName)}</span>
        )}
      </span>
      <span className="min-w-0 truncate">{activeWorkspaceName}</span>
      {isPro && badgeText ? (
        <span
          className="ml-2 inline-flex shrink-0 items-center rounded-full bg-sky-400/10 px-1.5 py-0.5 text-[8.5px] font-medium tracking-[0.07em] text-sky-700/80 dark:bg-sky-300/8 dark:text-sky-200/75"
          aria-label={`${badgeText} plan`}
          title={`${badgeText} plan`}
        >
          {badgeText}
        </span>
      ) : null}
    </div>
  );
}


