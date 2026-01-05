/**
 * Client shell for `/dashboard/*` — top bar (logo left, account menu right) + auth redirect.
 */
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import AccountMenu from "@/components/AccountMenu";
import ActiveWorkspacePill from "@/components/ActiveWorkspacePill";
import { useAuthEnabled } from "@/app/providers";
import Modal from "@/components/modals/Modal";
import Alert from "@/components/ui/Alert";
import { ORGS_CACHE_UPDATED_EVENT, readOrgsCacheSnapshot, refreshOrgsCache } from "@/lib/orgsCache";
import { CREDITS_SNAPSHOT_REFRESH_EVENT } from "@/lib/client/creditsSnapshotRefresh";
import { UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";

function AuthRedirector() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "unauthenticated") return;
    if (typeof window !== "undefined") window.location.assign("/");
  }, [status]);

  return null;
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const authEnabled = useAuthEnabled();
  const { resolvedTheme } = useTheme();
  const { data: session } = useSession();
  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [orgReady, setOrgReady] = useState(false);
  const [credits, setCredits] = useState<null | {
    creditsRemaining: number;
    includedRemaining: number;
    paidRemaining: number;
    usedThisCycle: number;
    cycleEnd: string | null;
    includedThisCycle: number | null;
    onDemandUsedCreditsThisCycle: number;
    onDemandMonthlyLimitCents: number;
    blocked: boolean;
  }>(null);
  const [creditsBusy, setCreditsBusy] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const creditsBusyRef = useRef(false);
  const pendingCreditsRefreshRef = useRef(false);
  // null = unknown (avoid flicker), boolean = known
  const [bannerDismissed, setBannerDismissed] = useState<boolean | null>(null);

  const BANNER_DISMISS_STORAGE_PREFIX = "lnkdrp:creditsBlockedBannerDismissed:";

  function cycleDismissKey(opts: { orgId: string; cycleEnd: string | null }): string | null {
    if (!opts.orgId) return null;
    if (!opts.cycleEnd) return null;
    return `${BANNER_DISMISS_STORAGE_PREFIX}${opts.orgId}:${opts.cycleEnd}`;
  }

  function readDismissedForCycle(opts: { orgId: string; cycleEnd: string | null }): boolean {
    try {
      const key = cycleDismissKey(opts);
      if (!key) return false;
      return window.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  function writeDismissedForCycle(opts: { orgId: string; cycleEnd: string | null }, dismissed: boolean) {
    try {
      const key = cycleDismissKey(opts);
      if (!key) return;
      if (dismissed) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  function publishCreditsBannerState(state: {
    orgId: string;
    cycleEnd: string | null;
    blocked: boolean;
    dismissed: boolean;
  }) {
    try {
      window.dispatchEvent(new CustomEvent("lnkdrp:credits-blocked-banner", { detail: state }));
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const hydrate = () => {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      const activeId = typeof snap.activeOrgId === "string" ? snap.activeOrgId : "";
      if (!cancelled) {
        setActiveOrgId(activeId);
        setOrgReady(true);
      }
    };

    hydrate();

    // Best-effort refresh so active org id is accurate for per-workspace persistence.
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

  // Avoid hydration mismatches from client-only sources.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const logoSrc = mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";
  const creditsUnlimited = Boolean(credits && credits.onDemandMonthlyLimitCents >= UNLIMITED_LIMIT_CENTS);

  async function refreshCredits(includeSpend = false) {
    setCreditsBusy(true);
    setCreditsError(null);
    creditsBusyRef.current = true;
    try {
      const qs = new URLSearchParams();
      if (includeSpend) qs.set("includeSpend", "1");
      const res = await fetch(`/api/credits/snapshot?${qs.toString()}`, { method: "GET" });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      setCredits({
        creditsRemaining: typeof json?.creditsRemaining === "number" ? json.creditsRemaining : 0,
        includedRemaining: typeof json?.includedRemaining === "number" ? json.includedRemaining : 0,
        paidRemaining: typeof json?.paidRemaining === "number" ? json.paidRemaining : 0,
        usedThisCycle: typeof json?.usedThisCycle === "number" ? json.usedThisCycle : 0,
        cycleEnd: typeof json?.cycleEnd === "string" ? json.cycleEnd : null,
        includedThisCycle: typeof json?.includedThisCycle === "number" ? json.includedThisCycle : null,
        onDemandUsedCreditsThisCycle: typeof json?.onDemandUsedCreditsThisCycle === "number" ? json.onDemandUsedCreditsThisCycle : 0,
        onDemandMonthlyLimitCents: typeof json?.onDemandMonthlyLimitCents === "number" ? json.onDemandMonthlyLimitCents : 0,
        blocked: Boolean(json?.blocked),
      });

      const cycleEnd = typeof json?.cycleEnd === "string" ? json.cycleEnd : null;
      const blocked = Boolean(json?.blocked);
      const dismissed: boolean | null = !blocked
        ? false
        : activeOrgId && cycleEnd
          ? readDismissedForCycle({ orgId: activeOrgId, cycleEnd })
          : orgReady && !activeOrgId
            ? false
            : null;
      setBannerDismissed(dismissed);
      if (dismissed !== null) publishCreditsBannerState({ orgId: activeOrgId, cycleEnd, blocked, dismissed });
    } catch (e) {
      setCreditsError(e instanceof Error ? e.message : "Failed to load credits");
      // Preserve the last-known snapshot to avoid flicker in the header badge/drawer.
    } finally {
      setCreditsBusy(false);
      creditsBusyRef.current = false;
      if (pendingCreditsRefreshRef.current) {
        pendingCreditsRefreshRef.current = false;
        // Best-effort refresh one more time after the in-flight request finishes.
        void refreshCredits(false);
      }
    }
  }

  useEffect(() => {
    void refreshCredits(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global refresh trigger (e.g. after Limits changes).
  useEffect(() => {
    function onRefresh() {
      if (creditsBusyRef.current) {
        pendingCreditsRefreshRef.current = true;
        return;
      }
      void refreshCredits(false);
    }
    window.addEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Reset dismissal when credits become available again, or when org/cycle changes.
    if (!credits) return;
    const cycleEnd = credits.cycleEnd ?? null;
    const blocked = Boolean(credits.blocked);
    if (!blocked) {
      writeDismissedForCycle({ orgId: activeOrgId, cycleEnd }, false);
      if (bannerDismissed !== false) setBannerDismissed(false);
      publishCreditsBannerState({ orgId: activeOrgId, cycleEnd, blocked: false, dismissed: false });
      return;
    }
    if (activeOrgId && cycleEnd) {
      const dismissed = readDismissedForCycle({ orgId: activeOrgId, cycleEnd });
      if (dismissed !== bannerDismissed) setBannerDismissed(dismissed);
      publishCreditsBannerState({ orgId: activeOrgId, cycleEnd, blocked: true, dismissed });
      return;
    }
    if (orgReady && !activeOrgId) {
      // If org id can't be resolved, we can't persist per-workspace dismissal; default to showing the banner.
      if (bannerDismissed !== false) setBannerDismissed(false);
      publishCreditsBannerState({ orgId: activeOrgId, cycleEnd, blocked: true, dismissed: false });
      return;
    }
    if (bannerDismissed !== null) setBannerDismissed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, orgReady, credits?.cycleEnd, credits?.blocked]);

  const blockedBanner = useMemo(() => {
    if (!credits) return null;
    if (!credits.blocked) return null;
    // Avoid flicker: don't render until dismissal status is known.
    if (bannerDismissed !== false) return null;
    const onDemandConfigured = credits.onDemandMonthlyLimitCents > 0;
    const ctaLabel = onDemandConfigured ? "Increase limit" : "View limits";
    return (
      <div className="bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
        <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-3 px-0 md:px-2">
          <div className="font-semibold">AI tools are currently unavailable. You’ve used all credits for this billing cycle.</div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/limits"
              className="rounded-lg border border-amber-900/[0.06] bg-amber-50/60 px-[8px] py-[3px] text-[11px] font-semibold text-stone-900/90 hover:bg-amber-50/68 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900/15 dark:border-amber-100/[0.06] dark:bg-[#f3e7d3]/32 dark:hover:bg-[#f3e7d3]/38 dark:focus-visible:outline-amber-100/15"
            >
              {ctaLabel}
            </Link>
            <button
              type="button"
              className="text-[11px] font-semibold text-amber-900/70 hover:text-amber-900/80 dark:text-amber-200/60 dark:hover:text-amber-200/75"
              onClick={() => {
                if (!credits) return;
                const cycleEnd = credits.cycleEnd ?? null;
                writeDismissedForCycle({ orgId: activeOrgId, cycleEnd }, true);
                setBannerDismissed(true);
                publishCreditsBannerState({ orgId: activeOrgId, cycleEnd, blocked: true, dismissed: true });
              }}
              aria-label="Dismiss credits banner"
              title="Dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }, [credits, bannerDismissed, activeOrgId]);

  function formatShortDate(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return iso.slice(0, 10);
    }
  }

  return (
    <div className="min-h-[100svh] w-full bg-[var(--bg)] text-[var(--fg)]">
      {authEnabled ? <AuthRedirector /> : null}

      <header className="bg-[var(--bg)]">
        {/* Full-width header: logo pinned left, account menu pinned right. */}
        {/* Keep the logo + workspace pill identical to the app shell (desktop sidebar + mobile top bar). */}
        <div className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg)] px-3 md:h-auto md:items-start md:border-b-0 md:px-4 md:pb-7 md:pt-6">
          <div className="flex min-w-0 items-center gap-2">
            <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
              <Image src={logoSrc} alt="LinkDrop" width={31} height={31} priority />
            </Link>
            <ActiveWorkspacePill
              className="hidden sm:inline-flex"
              maxWidthClassName="max-w-[160px]"
              textClassName="text-[11px]"
            />
          </div>

          <div className="shrink-0">
            <div className="flex items-center gap-2">
              <Link
                href="/dashboard?tab=usage"
                className={`rounded-xl border border-[color-mix(in_srgb,var(--border)_30%,transparent)] bg-[var(--panel)] px-3 py-2 text-[11px] font-semibold hover:bg-[var(--panel-hover)] ${creditsUnlimited ? "text-emerald-700 dark:text-emerald-300" : "text-[var(--fg)]"}`}
                title="View usage"
              >
                Credits:
                {credits ? (
                  creditsUnlimited ? (
                    <span className="inline-flex items-baseline">
                      <span className="ml-1.5 mr-1.5 text-emerald-700 dark:text-emerald-300" aria-hidden="true">
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          xmlns="http://www.w3.org/2000/svg"
                          className="relative top-[1.5px] block"
                        >
                          <path d="M3 7l4.5 4.5L12 6l4.5 5.5L21 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm2 4.414V17h14v-5.586l-2.5 2.5L12 8l-4.5 5.914L5 11.414z" />
                        </svg>
                      </span>
                      <span>Unlimited</span>
                    </span>
                  ) : (
                    <span className="ml-1">{Math.max(0, Math.floor(credits.creditsRemaining)).toLocaleString()}</span>
                  )
                ) : (
                  <span className="ml-1">—</span>
                )}
              </Link>
              <AccountMenu variant="topbar" />
            </div>
          </div>
        </div>
      </header>

      {blockedBanner}

      <main className="mx-auto w-full max-w-[1280px] px-5 py-8">{children}</main>

      <Modal
        open={creditsOpen}
        onClose={() => setCreditsOpen(false)}
        ariaLabel="Credits breakdown"
      >
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Credits</div>
        <div className="mt-1 text-[13px] text-[var(--muted-2)]">Your workspace credits and billing cycle.</div>

        {creditsError ? (
          <Alert variant="error" className="mt-4 text-[12px]">
            {creditsError}
          </Alert>
        ) : null}

        <div className="mt-5 grid gap-3">
          <div className="rounded-xl bg-[var(--panel-2)] p-4">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Credits remaining</div>
            <div className="mt-2 text-[26px] font-semibold tracking-tight text-[var(--fg)]">
              {credits ? Math.max(0, Math.floor(credits.creditsRemaining)).toLocaleString() : "—"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[var(--panel-2)] p-4">
              <div className="text-[12px] font-semibold text-[var(--muted-2)]">Included this cycle</div>
              <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">
                {credits?.includedThisCycle != null
                  ? Math.max(0, Math.floor(credits.includedThisCycle)).toLocaleString()
                  : "—"}
              </div>
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                Remaining: {credits ? Math.max(0, Math.floor(credits.includedRemaining)).toLocaleString() : "—"}
              </div>
            </div>
            <div className="rounded-xl bg-[var(--panel-2)] p-4">
              <div className="text-[12px] font-semibold text-[var(--muted-2)]">Extra credits</div>
              <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">
                {credits ? Math.max(0, Math.floor(credits.paidRemaining)).toLocaleString() : "—"}
              </div>
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                Includes purchased credits + on-demand headroom (if enabled).
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-[var(--panel-2)] p-4">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Used this cycle</div>
            <div className="mt-2 text-[18px] font-semibold text-[var(--fg)]">
              {credits ? Math.max(0, Math.floor(credits.usedThisCycle)).toLocaleString() : "—"}
            </div>
            {credits && credits.onDemandMonthlyLimitCents > 0 ? (
              <div className="mt-1 text-[12px] text-[var(--muted-2)]">
                On-demand used:{" "}
                <span className="font-semibold text-[var(--fg)]">
                  {Math.max(0, Math.floor(credits.onDemandUsedCreditsThisCycle)).toLocaleString()}
                </span>{" "}
                credits
              </div>
            ) : null}
            <div className="mt-1 text-[12px] text-[var(--muted-2)]">
              Resets on:{" "}
              <span className="font-semibold text-[var(--fg)]">
                {credits?.cycleEnd ? formatShortDate(credits.cycleEnd) : "—"}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Link
            href="/dashboard/limits"
            className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
            onClick={() => setCreditsOpen(false)}
          >
            Limits
          </Link>
          <Link
            href="/dashboard?tab=usage"
            className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]"
            onClick={() => setCreditsOpen(false)}
          >
            View usage
          </Link>
        </div>
      </Modal>
    </div>
  );
}


