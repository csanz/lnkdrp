/**
 * Dashboard Limits card: AI Quality Defaults.
 *
 * Two questions, in the order they matter: whether the automatic runs happen at all, then how
 * deeply they run. The switches cover the summary on upload, the compare on replacement and the
 * brief after a recipient's visit — the three runs that start without anyone asking. Everything else waits to be asked, and not asking
 * is already its off switch.
 *
 * Lets workspace owners/admins set default quality tiers per credit-metered action. The summary is
 * not a choice: lnkdrp's own summary agent writes it after every upload at the basic level, one
 * credit per upload (`creditsForRun`); 0 when the uploader's own agent supplies it or a recipient
 * uploaded the file. AI compare runs at Basic on Free and Standard on Pro by default. The Review column only shows when Requests are enabled
 * (`NEXT_PUBLIC_FEATURE_REQUESTS=1`), since reviews run on request uploads and are not released.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { cn } from "@/lib/cn";
import { dispatchCreditsSnapshotRefresh } from "@/lib/client/creditsSnapshotRefresh";

type Tier = "standard" | "advanced";

const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

type ApiResponse =
  | { ok: true; review: Tier; history: Tier; autoSummary?: boolean; autoCompare?: boolean; autoBrief?: boolean }
  | { error: string };

type TierAll = "basic" | "standard" | "advanced";

function normalizeTier(v: unknown): TierAll {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "basic") return "basic";
  if (s === "advanced") return "advanced";
  return "standard";
}

/**
 * The only three AI runs that start on their own, so the only three a switch can turn off.
 *
 * Worded as what happens rather than what it costs: someone turning the summary off is usually
 * reacting to noise on a busy day, not to credits, and a line about credits would read as a nudge
 * back toward the setting they just changed.
 */
const AUTOMATIC_RUNS = [
  {
    key: "summary" as const,
    title: "Summarise every upload",
    body: "A summary and key points written right after a file is uploaded, so a link has something to say before anyone opens it. Off, you can still write one from the document page whenever you want it.",
  },
  {
    key: "compare" as const,
    title: "Compare every replacement",
    body: "When you replace a document, an explanation of what changed between the old version and the new one. Off, you can still run a compare from version history.",
  },
  {
    key: "brief" as const,
    title: "Brief every visit",
    body: "A few minutes after a recipient stops reading, a short account of the visit: what held them, what they skipped, whether they came back. One credit per visit, on Pro. Off, the email still carries the facts of the visit, without the write-up.",
  },
];

export default function AiQualityDefaultsCard({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Null until the GET succeeds. These used to start at "standard", which is a real, billable choice
  // (5 credits) and not the actual default for anyone: compare falls back to Basic on Free, and any
  // workspace that had picked Basic saw "Standard" selected anyway. Combined with a `dirty` that was
  // hard-coded to true, a member hitting the 403 or an admin hitting a transient GET failure could
  // click Save under the error message and overwrite the real stored tiers with that invented one.
  // Null renders every radio unchecked and disabled, so nothing is claimed about the workspace until
  // the server has actually told us.
  const [reviewTier, setReviewTier] = useState<TierAll | null>(null);
  const [historyTier, setHistoryTier] = useState<TierAll | null>(null);
  // What the last successful load returned. Also the "not loaded" flag, and what Save compares
  // against so an untouched card cannot re-write values it merely displayed.
  const [loaded, setLoaded] = useState<{
    review: TierAll;
    history: TierAll;
    autoSummary: boolean;
    autoCompare: boolean;
    autoBrief: boolean;
  } | null>(null);
  // Same rule as the tiers: null until the server answers, so an unchecked box never claims the
  // workspace turned something off.
  const [autoSummary, setAutoSummary] = useState<boolean | null>(null);
  const [autoCompare, setAutoCompare] = useState<boolean | null>(null);
  const [autoBrief, setAutoBrief] = useState<boolean | null>(null);

  const dirty = useMemo(
    () =>
      loaded !== null &&
      (reviewTier !== loaded.review ||
        historyTier !== loaded.history ||
        autoSummary !== loaded.autoSummary ||
        autoCompare !== loaded.autoCompare ||
        autoBrief !== loaded.autoBrief),
    [loaded, reviewTier, historyTier, autoSummary, autoCompare, autoBrief],
  );

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/credits/quality-defaults", { method: "GET" });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
      if (!json || (json as any).ok !== true) throw new Error("Invalid response");
      const review = normalizeTier((json as any).review);
      const history = normalizeTier((json as any).history);
      // Absent reads as on, matching `isAutomationOn` on the server.
      const summaryOn = (json as any).autoSummary !== false;
      const compareOn = (json as any).autoCompare !== false;
      const briefOn = (json as any).autoBrief !== false;
      setReviewTier(review);
      setHistoryTier(history);
      setAutoSummary(summaryOn);
      setAutoCompare(compareOn);
      setAutoBrief(briefOn);
      setLoaded({ review, history, autoSummary: summaryOn, autoCompare: compareOn, autoBrief: briefOn });
    } catch (e) {
      // Leave the tiers null: the card shows the error with nothing selected rather than a guess.
      setError(e instanceof Error ? e.message : "Failed to load defaults");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    // Belt and braces: the button is disabled in these states, but a save with nothing loaded would
    // be exactly the overwrite this card used to do, so refuse it here too.
    if (!dirty || !reviewTier || !historyTier || autoSummary === null || autoCompare === null || autoBrief === null) return;
    setSaveBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/credits/quality-defaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewQualityTier: reviewTier,
          historyQualityTier: historyTier,
          autoSummary,
          autoCompare,
          autoBrief,
        }),
      });
      const json = (await res.json().catch(() => null)) as ApiResponse | null;
      if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
      if (!json || (json as any).ok !== true) throw new Error("Invalid response");
      // The saved values are now the server's values, so the card goes clean and Save re-disables.
      setLoaded({ review: reviewTier, history: historyTier, autoSummary, autoCompare, autoBrief });
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
    <div className={cn("rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[var(--shadow-card)] p-4 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-[var(--fg)]">AI quality defaults</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            Defaults for new credit-metered runs. You can still pick a quality each time you run one.
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

      <div className="mt-5 space-y-2">
        {AUTOMATIC_RUNS.map((run) => {
          const on = run.key === "summary" ? autoSummary : run.key === "compare" ? autoCompare : autoBrief;
          const set = run.key === "summary" ? setAutoSummary : run.key === "compare" ? setAutoCompare : setAutoBrief;
          return (
            <label
              key={run.key}
              className="flex cursor-pointer items-start gap-3 rounded-xl bg-[var(--panel-2)] p-4"
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary-bg)]"
                checked={on ?? false}
                disabled={busy || saveBusy || on === null}
                onChange={(e) => set(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-[var(--fg)]">{run.title}</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-[var(--muted-2)]">{run.body}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className={cn("mt-5 grid gap-3", FEATURE_REQUESTS_ENABLED ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">Summary and key points</div>
            <HelpTooltip
              label="Who writes the summary?"
              body="lnkdrp's own summary agent writes the summary and key points after every upload, at the basic level. One credit per upload. Free when your own agent writes the summary through MCP or the API, and for files recipients upload through a request or replace link."
            />
          </div>
          <div className="mt-2 text-[13px] font-semibold text-[var(--fg)]">1 credit</div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">Written by LinkDrop after every upload, at the basic level. 0 credits when your agent writes it.</div>
        </div>

        {FEATURE_REQUESTS_ENABLED ? (
        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">AI review</div>
            <HelpTooltip
              label="What is AI review?"
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
                disabled={busy || saveBusy || !loaded}
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
                disabled={busy || saveBusy || !loaded}
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
                disabled={busy || saveBusy || !loaded}
              />
              <span className="font-semibold text-[var(--fg)]">Advanced</span>
              <span className="text-[var(--muted-2)]">(12 credits)</span>
            </label>
          </div>
          <div className="mt-2 text-[12px] text-[var(--muted-2)]">Used when you click “Run review”.</div>
        </div>
        ) : null}

        <div className="rounded-xl bg-[var(--panel-2)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12px] font-semibold text-[var(--muted-2)]">AI compare</div>
            <HelpTooltip
              label="What is AI compare?"
              body="Compares two versions of a document and explains what changed. Basic is fastest and cheapest. Standard is balanced. Advanced is the most thorough."
            />
          </div>
          <div className="mt-3 grid gap-2 text-[12px] text-[var(--muted-2)]">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="historyTier"
                checked={historyTier === "basic"}
                onChange={() => setHistoryTier("basic")}
                disabled={busy || saveBusy || !loaded}
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
                disabled={busy || saveBusy || !loaded}
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
                disabled={busy || saveBusy || !loaded}
              />
              <span className="font-semibold text-[var(--fg)]">Advanced</span>
              <span className="text-[var(--muted-2)]">(12 credits)</span>
            </label>
          </div>
          <div className="mt-2 text-[12px] text-[var(--muted-2)]">
            Used for the compare on every replacement above, and when you run or regenerate one by hand. Without a saved
            default, compare runs at Basic on Free and Standard on Pro.
          </div>
        </div>
      </div>
    </div>
  );
}


