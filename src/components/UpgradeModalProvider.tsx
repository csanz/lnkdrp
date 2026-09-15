/**
 * UpgradeModalProvider — mounts one `UpgradeModal` for the whole app and exposes
 * `useUpgradeModal()` so any component (doc page, sidebar, dashboard cards) can open it.
 *
 * Mounted once in `src/app/providers.tsx`, which wraps both the `(app)` shell and `/dashboard`.
 * `openUpgrade` is a no-op for Pro workspaces (checked against the cached plan snapshot; the modal
 * double-checks once it mounts) and records `markPlanLimitHit` for keys that mirror an API limit so
 * the sidebar's fallback nudge knows a cap was hit this session.
 */
"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import UpgradeModal from "@/components/UpgradeModal";
import { markPlanLimitHit, type PlanLimitKey } from "@/lib/client/planLimit";
import { peekPlan } from "@/lib/client/usePlan";
import type { UpsellKey } from "@/lib/client/upsellCopy";

/** Optional context for the modal's reason line. */
export type OpenUpgradeOptions = { used?: number; max?: number; graceHint?: string | null };

/** What `useUpgradeModal()` returns. */
export type UpgradeModalApi = {
  openUpgrade: (key: UpsellKey, opts?: OpenUpgradeOptions) => void;
  close: () => void;
};

const UpgradeModalContext = createContext<UpgradeModalApi | null>(null);

/** Upsell keys that mirror an API `LimitKey` (and so feed `markPlanLimitHit`). */
const LIMIT_KEYS: ReadonlySet<UpsellKey> = new Set<UpsellKey>(["documents", "projects", "collaborators", "version_history", "analytics_history"]);

/** Provide the upgrade-modal API and render the modal after `children` so it stacks above other modals. */
export function UpgradeModalProvider({
  children,
  checkoutEnabled = false,
}: {
  children: React.ReactNode;
  /** True when auth is enabled: the modal may start Stripe Checkout for signed-in workspaces. */
  checkoutEnabled?: boolean;
}) {
  const [state, setState] = useState<{ key: UpsellKey; opts: OpenUpgradeOptions } | null>(null);

  const close = useCallback(() => setState(null), []);

  const openUpgrade = useCallback((key: UpsellKey, opts: OpenUpgradeOptions = {}) => {
    // Pro workspaces never see the modal.
    if (peekPlan()?.plan === "pro") return;
    if (LIMIT_KEYS.has(key)) markPlanLimitHit(key as PlanLimitKey);
    setState({ key, opts });
  }, []);

  const value = useMemo<UpgradeModalApi>(() => ({ openUpgrade, close }), [openUpgrade, close]);

  return (
    <UpgradeModalContext.Provider value={value}>
      {children}
      {state ? (
        <UpgradeModal
          open
          upsellKey={state.key}
          used={state.opts.used}
          max={state.opts.max}
          graceHint={state.opts.graceHint}
          onClose={close}
          checkoutEnabled={checkoutEnabled}
        />
      ) : null}
    </UpgradeModalContext.Provider>
  );
}

/** Access the upgrade modal; throws when rendered outside `UpgradeModalProvider`. */
export function useUpgradeModal(): UpgradeModalApi {
  const ctx = useContext(UpgradeModalContext);
  if (!ctx) throw new Error("useUpgradeModal must be used within UpgradeModalProvider");
  return ctx;
}
