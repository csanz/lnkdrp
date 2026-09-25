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
import UpgradeModal, { type UpgradeModalCta } from "@/components/UpgradeModal";
import { funnelSurface, trackFunnel } from "@/lib/client/funnel";
import { markPlanLimitHit, type PlanLimitKey } from "@/lib/client/planLimit";
import { peekPlan } from "@/lib/client/usePlan";
import type { UpsellKey } from "@/lib/client/upsellCopy";

/**
 * Optional context for the modal's reason line, plus `from`: the surface opening it, for the
 * funnel row. Left out, it is derived from the page path (`funnelSurface`), which is right for
 * nearly every caller; pass it when one page hosts several upsell surfaces worth telling apart.
 */
export type OpenUpgradeOptions = { used?: number; max?: number; graceHint?: string | null; from?: string | null };

/** What `useUpgradeModal()` returns. */
export type UpgradeModalApi = {
  openUpgrade: (key: UpsellKey, opts?: OpenUpgradeOptions) => void;
  close: () => void;
};

const UpgradeModalContext = createContext<UpgradeModalApi | null>(null);

/** Upsell keys that mirror an API `LimitKey` (and so feed `markPlanLimitHit`). */
const LIMIT_KEYS: ReadonlySet<UpsellKey> = new Set<UpsellKey>([
  "documents",
  "projects",
  "collaborators",
  "version_history",
  "analytics_history",
  "project_links",
]);

/** Provide the upgrade-modal API and render the modal after `children` so it stacks above other modals. */
export function UpgradeModalProvider({
  children,
  checkoutEnabled = false,
}: {
  children: React.ReactNode;
  /** True when auth is enabled: the modal may start Stripe Checkout for signed-in workspaces. */
  checkoutEnabled?: boolean;
}) {
  const [state, setState] = useState<{ key: UpsellKey; opts: OpenUpgradeOptions; from: string | null } | null>(null);

  const close = useCallback(() => setState(null), []);

  const openUpgrade = useCallback((key: UpsellKey, opts: OpenUpgradeOptions = {}) => {
    // Pro workspaces never see the modal.
    if (peekPlan()?.plan === "pro") return;
    if (LIMIT_KEYS.has(key)) markPlanLimitHit(key as PlanLimitKey);
    const from = opts.from ?? funnelSurface(typeof window !== "undefined" ? window.location.pathname : null);
    // The funnel's middle step: the wall was shown. `plan.limit_reached` (server) is the step before,
    // `cta_clicked` and `checkout.started` the ones after.
    trackFunnel("modal_shown", { reason: key, from });
    setState({ key, opts, from });
  }, []);

  // What was pressed on the open modal, before it closes or navigates away.
  const onCta = useCallback(
    (cta: UpgradeModalCta) => {
      if (!state) return;
      trackFunnel("cta_clicked", { reason: state.key, from: state.from, cta });
    },
    [state],
  );

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
          onCta={onCta}
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
