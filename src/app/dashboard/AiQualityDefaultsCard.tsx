/**
 * Dashboard Limits card: AI Quality Defaults.
 *
 * Lets workspace owners/admins set default quality tiers per action.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { cn } from "@/lib/cn";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";

type Tier = "standard" | "advanced";

type ApiResponse =
  | { ok: true; review: Tier; history: Tier }
  | { error: string };

type TierAll = "basic" | "standard" | "advanced";

function normalizeTier(v: unknown): TierAll {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "basic") return "basic";
  if (s === "advanced") return "advanced";
  return "standard";
}

export default function AiQualityDefaultsCard({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [reviewTier, setReviewTier] = useState<TierAll>("standard");
  const [historyTier, setHistoryTier] = useState<TierAll>("standard");

  const dirty = useMemo(() => true, [reviewTier, historyTier]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/credits/quality-defaults", { method: "GET" });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
      if (!json || (json as any).ok !== true) throw new Error("Invalid response");
      setReviewTier(normalizeTier((json as any).review));
      setHistoryTier(normalizeTier((json as any).history));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load defaults");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaveBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/credits/quality-defaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewQualityTier: reviewTier, historyQualityTier: historyTier }),
      });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
      if (!json || (json as any).ok !== true) throw new Error("Invalid response");
      setSaved("Saved.");
      // Best-effort refresh so other UI that reads snapshot/usage stays up-to-date.
      dispatchCreditsSnapshotRefresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save defaults");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div className={cn("rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">AI Quality Defaults</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            Defaults for new runs. You can still override quality when you run Review Agent/History Agent.
          </div>
        </div>
        <Button
          variant="solid"
          className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
          disabled={busy || saveBusy || !dirty}
          onClick={() => void save()}
        >
          {saveBusy ? "Saving…" : "Save"}
        </Button>
      </div>

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}
      {saveError ? (
        <Alert variant="error" className="mt-3 text-[12px]">
          {saveError}
        </Alert>
      ) : null}
      {saved ? (
        <Alert variant="info" className="mt-3 text-[12px]">
          {saved}
        </Alert>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Summary Agent</div>
            <HelpTooltip
              label="What is Summary Agent?"
              body="Creates a quick overview after upload. Basic is lowest cost, short context, and no retries."
            />
          </div>
          <div className="mt-2 text-[13px] font-semibold text-[var(--fg)]">Basic (auto)</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">Runs automatically after upload.</div>
        </div>

        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Review Agent</div>
            <HelpTooltip
              label="What is Review Agent?"
              body="A deeper quality assessment you run on-demand. Basic is fastest/cheapest. Standard is balanced. Advanced uses more context and retries."
            />
          </div>
          <div className="mt-3 grid gap-2 text-[12px] text-[var(--muted-2)]">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="reviewTier"
                checked={reviewTier === "basic"}
                onChange={() => setReviewTier("basic")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Basic</span>
              <span className="text-[var(--muted-2)]">(2 credits)</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="reviewTier"
                checked={reviewTier === "standard"}
                onChange={() => setReviewTier("standard")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Standard</span>
              <span className="text-[var(--muted-2)]">(5 credits)</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="reviewTier"
                checked={reviewTier === "advanced"}
                onChange={() => setReviewTier("advanced")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Advanced</span>
              <span className="text-[var(--muted-2)]">(12 credits)</span>
            </label>
          </div>
          <div className="mt-2 text-[12px] text-[var(--muted-2)]">Used when you click “Run review”.</div>
        </div>

        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">History Agent</div>
            <HelpTooltip
              label="What is History Agent?"
              body="Compares two versions and summarizes changes. Basic is fastest/cheapest. Standard is balanced. Advanced is most thorough."
            />
          </div>
          <div className="mt-3 grid gap-2 text-[12px] text-[var(--muted-2)]">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="historyTier"
                checked={historyTier === "basic"}
                onChange={() => setHistoryTier("basic")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Basic</span>
              <span className="text-[var(--muted-2)]">(2 credits)</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="historyTier"
                checked={historyTier === "standard"}
                onChange={() => setHistoryTier("standard")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Standard</span>
              <span className="text-[var(--muted-2)]">(5 credits)</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="historyTier"
                checked={historyTier === "advanced"}
                onChange={() => setHistoryTier("advanced")}
                disabled={busy || saveBusy}
              />
              <span className="font-semibold text-[var(--fg)]">Advanced</span>
              <span className="text-[var(--muted-2)]">(12 credits)</span>
            </label>
          </div>
          <div className="mt-2 text-[12px] text-[var(--muted-2)]">Used when you regenerate a diff.</div>
        </div>
      </div>
    </div>
  );
}


