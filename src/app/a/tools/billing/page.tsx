/**
 * Admin route: `/a/tools/billing`
 *
 * One stored value — the Pro price label the dashboard shows — and the one button that goes to
 * Stripe for a fresh one. The page is two facts and two actions, so it is laid out as two facts
 * and two actions rather than a panel of prose.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import { AdminAccessState, AdminAlert, AdminPageHeader, TimeCell, useAdminAccess } from "@/components/admin";
import { ADMIN_DASH, ADMIN_FIELD_LABEL, ADMIN_NOTE, ADMIN_PANEL_TEXT } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type ProPriceResponse = {
  ok: true;
  proPriceLabel: string | null;
  updatedDate: string | null;
};

/** The billing tools page: the stored Pro price label, and the refresh that refetches it. */
export default function AdminBillingToolsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [data, setData] = useState<ProPriceResponse | null>(null);

  const label = useMemo(() => (typeof data?.proPriceLabel === "string" ? data.proPriceLabel.trim() : ""), [data?.proPriceLabel]);

  /** Read the stored billing config. Never calls Stripe. */
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<ProPriceResponse>(`/api/admin/billing/pro-price`, { method: "GET" });
      setData(res);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Failed to load billing config");
    } finally {
      setLoading(false);
    }
  }

  /** Ask Stripe for the current price and store what comes back. */
  async function refreshFromStripe() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetchJson<ProPriceResponse>(`/api/admin/billing/pro-price`, { method: "POST" });
      setData(res);
      setSuccess("Refreshed from Stripe.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh from Stripe");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!canUseAdmin) return;
    void load();
  }, [canUseAdmin]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Billing tools" description="The billing values stored in Mongo, and the one button that refetches them from Stripe." callbackUrl="/a/tools/billing" />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Billing tools"
          description="The billing values stored in Mongo, and the one button that refetches them from Stripe."
          actions={
            <>
              <Button variant="outline" onClick={() => void load()} disabled={loading || refreshing}>
                {loading ? "Loading…" : "Reload"}
              </Button>
              <Button
                variant="solid"
                className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                onClick={() => void refreshFromStripe()}
                disabled={loading || refreshing}
              >
                {refreshing ? "Refreshing…" : "Refresh from Stripe"}
              </Button>
            </>
          }
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}
        {success ? (
          <AdminAlert tone="positive" className="mt-3">
            {success}
          </AdminAlert>
        ) : null}

        <Panel padding="md" rounded="xl" className="mt-4 min-w-0 max-w-3xl">
          <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Pro price label</div>
          <p className={`mt-1 ${ADMIN_PANEL_TEXT}`}>
            What the dashboard&apos;s Plan card prints. Served by <span className="font-mono text-[12px]">/api/billing/status</span>{" "}
            from Mongo. A normal dashboard load never calls Stripe.
          </p>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className={ADMIN_FIELD_LABEL}>Current label</dt>
              <dd className="mt-1 text-[15px] font-semibold leading-6 text-[var(--fg)]">{label || ADMIN_DASH}</dd>
            </div>
            <div>
              <dt className={ADMIN_FIELD_LABEL}>Last updated</dt>
              <dd className="mt-1 text-[15px] font-semibold leading-6 tabular-nums text-[var(--fg)]">
                <TimeCell value={data?.updatedDate ?? null} />
              </dd>
            </div>
          </dl>

          <p className={ADMIN_NOTE}>
            Refreshing calls Stripe once and invalidates the cached value; nothing else on this deployment does.
          </p>
        </Panel>
      </div>
    </div>
  );
}
