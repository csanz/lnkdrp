/**
 * Admin route: `/a/tools/billing`
 *
 * Small admin tool to refresh billing UI config (e.g. Pro price label) from Stripe.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import { fetchJson } from "@/lib/http/fetchJson";

type ProPriceResponse = {
  ok: true;
  proPriceLabel: string | null;
  updatedDate: string | null;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function AdminBillingToolsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [data, setData] = useState<ProPriceResponse | null>(null);

  const label = useMemo(() => (typeof data?.proPriceLabel === "string" ? data.proPriceLabel.trim() : ""), [data?.proPriceLabel]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseAdmin]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Billing tools</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/tools/billing" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Billing tools</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Billing tools</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Refresh and inspect billing UI config stored in MongoDB.</p>
          </div>
          <Link
            href="/a"
            className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
          >
            Admin home
          </Link>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}
        {success ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-emerald-700">
            {success}
          </Alert>
        ) : null}

        <div className="mt-6 grid gap-4">
          <Panel className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--fg)]">Pro price label</div>
                <div className="mt-1 text-[13px] text-[var(--muted)]">
                  Used by `/api/billing/status` (dashboard Plan card). Stored in Mongo; cache invalidates on refresh.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => void load()} disabled={loading || refreshing}>
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
              </div>
            </div>

            <div className="mt-4 grid gap-2 text-[13px] text-[var(--muted)]">
              <div>
                <span className="font-semibold text-[var(--fg)]">Current label:</span> {label || "—"}
              </div>
              <div>
                <span className="font-semibold text-[var(--fg)]">Last updated:</span> {fmtDate(data?.updatedDate ?? null)}
              </div>
              <div className="text-xs text-[var(--muted-2)]">
                Note: This calls Stripe only when you click refresh. Normal dashboard loads do not call Stripe.
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}


