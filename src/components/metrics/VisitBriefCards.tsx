/**
 * One reader's finished visits, each with the brief the model wrote about it — or, when none was
 * written, the facts and a button that writes it now (docs/prds/lnkdrp-visit-briefs.md, "Surfaces").
 *
 * A card exists for every sitting that closed with something to say (`briefed`, `recap`, `failed`);
 * skipped ones — glances, the owner's own previews — have no card, and a Free workspace has none
 * at all (the endpoint answers 402), so the section disappears rather than explaining itself.
 *
 * "Write the brief" spends one credit and is billed to whoever clicks. The 402 codes are the same
 * ones every other AI action returns, so the out-of-credits modal opens on them unchanged.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownTrayIcon, SparklesIcon } from "@heroicons/react/24/outline";

import { formatDateTime, formatDurationShort } from "@/components/metrics/MetricsView";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { dispatchOutOfCredits, outOfCreditsReasonFromCode } from "@/lib/client/outOfCredits";
import type { VisitBriefCard } from "@/lib/visits/visitBriefs";

export type ReaderKey = { kind: "authed" | "anon"; key: string };

/** Why this visit got no write-up, in the owner's terms. */
export function recapReasonCopy(reason: VisitBriefCard["recapReason"]): string {
  switch (reason) {
    case "auto_off":
      return "Automatic briefs were off when this visit ended.";
    case "daily_cap":
      return "The workspace had already written its briefs for the day.";
    case "out_of_credits":
      return "The workspace was out of credits when this visit ended.";
    case "model_failed":
      return "The brief could not be written when this visit ended.";
    case "plan":
      return "Briefs are written on Pro.";
    default:
      return "No brief was written for this visit.";
  }
}

/** "1st visit", "2nd visit", ... */
export function visitOrdinal(n: number): string {
  const v = Math.max(1, Math.floor(n));
  const mod100 = v % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : v % 10 === 1 ? "st" : v % 10 === 2 ? "nd" : v % 10 === 3 ? "rd" : "th";
  return `${v}${suffix} visit`;
}

/**
 *
 */
export default function VisitBriefCards({
  apiBase,
  who,
  reloadKey,
}: {
  /** `/api/docs/:docId` or `/api/projects/:projectId` — the scope this reader is being looked at in. */
  apiBase: string;
  who: ReaderKey | null;
  /** Bumped by the page when something about this reader changed; the list refetches silently. */
  reloadKey: number;
}) {
  const [cards, setCards] = useState<VisitBriefCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** The endpoint said this workspace does not get briefs (Free): render nothing, say nothing. */
  const [hidden, setHidden] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!who) return;
    try {
      const params = new URLSearchParams({ kind: who.kind, limit: "50" });
      params.set(who.kind === "authed" ? "userId" : "botIdHash", who.key);
      const res = await fetchWithTempUser(`${apiBase}/visit-briefs?${params.toString()}`, { cache: "no-store" });
      if (res.status === 402) {
        setHidden(true);
        return;
      }
      if (!res.ok) return;
      const json = (await res.json()) as { visits?: VisitBriefCard[] };
      setCards(Array.isArray(json.visits) ? json.visits : []);
    } catch {
      // The page still has everything except the briefs; the next refresh tries again.
    } finally {
      setLoaded(true);
    }
  }, [apiBase, who]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const write = useCallback(
    async (id: string) => {
      setWriting(id);
      setFailed((f) => {
        const next = { ...f };
        delete next[id];
        return next;
      });
      try {
        const res = await fetchWithTempUser(`/api/visits/${encodeURIComponent(id)}/brief`, { method: "POST" });
        if (res.status === 402) {
          const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
          if (body?.code === "plan_limit") {
            setFailed((f) => ({ ...f, [id]: "Briefs are written on Pro." }));
          } else {
            dispatchOutOfCredits(outOfCreditsReasonFromCode(body?.code));
          }
          return;
        }
        if (res.status === 409) {
          // Someone (or the cron) got there first: whatever it wrote is the truth now.
          await load();
          return;
        }
        if (!res.ok) {
          setFailed((f) => ({ ...f, [id]: "The brief could not be written. Nothing was charged." }));
          return;
        }
        const json = (await res.json()) as { visit?: VisitBriefCard };
        if (json.visit) setCards((cs) => cs.map((c) => (c.id === id ? json.visit! : c)));
        else await load();
      } catch {
        setFailed((f) => ({ ...f, [id]: "The brief could not be written. Nothing was charged." }));
      } finally {
        setWriting(null);
      }
    },
    [load],
  );

  if (hidden || !who) return null;
  if (!cards.length) return null;
  void loaded;

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">
          Visit briefs{cards.length ? ` · ${cards.length >= 50 ? "50+" : cards.length}` : ""}
        </div>
        <div className="text-[12px] text-[var(--muted-2)]">Newest first</div>
      </div>
      <ul className="mt-3 grid gap-2">
        {cards.map((c) => {
          const facts = [
            c.timeSpentMs > 0 ? formatDurationShort(c.timeSpentMs) : null,
            c.docs.length > 1
              ? `${c.docs.length} documents`
              : c.pagesSeen > 0
                ? `${c.pagesSeen} ${c.pagesSeen === 1 ? "page" : "pages"}${c.pageCount ? ` of ${c.pageCount}` : ""}`
                : null,
            visitOrdinal(c.visitNumber),
          ].filter((x): x is string => Boolean(x));
          return (
            <li key={c.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--fg)]">{formatDateTime(c.startedAt)}</span>
                <span className="inline-flex items-center gap-1.5 text-[12px] tabular-nums text-[var(--muted)]">
                  {facts.join(" · ")}
                  {c.downloads > 0 ? (
                    <span className="inline-flex items-center gap-0.5" title={`${c.downloads} ${c.downloads === 1 ? "download" : "downloads"} during this visit`}>
                      <ArrowDownTrayIcon className="h-3 w-3" aria-hidden="true" />
                      {c.downloads}
                    </span>
                  ) : null}
                </span>
              </div>

              {c.brief ? (
                <div className="mt-2">
                  <div className="flex items-start gap-2">
                    <SparklesIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="text-[14px] font-semibold leading-snug text-[var(--fg)]">{c.brief.headline}</div>
                      <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{c.brief.body}</p>
                    </div>
                  </div>
                  {c.brief.interests.length ? (
                    <div className="mt-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">What caught their attention</div>
                      <ul className="mt-1 grid gap-0.5 text-[13px] text-[var(--fg)]">
                        {c.brief.interests.map((line, i) => (
                          <li key={i} className="flex gap-2">
                            <span aria-hidden="true" className="text-[var(--muted-2)]">·</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {c.brief.highlights.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {c.brief.highlights.map((h, i) => (
                        <span key={i} className="rounded-md bg-[var(--panel)] px-2 py-0.5 text-[11px] text-[var(--muted)] ring-1 ring-[var(--border)]">
                          {h}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {c.brief.followUp ? (
                    <p className="mt-2 text-[12px] text-[var(--muted)]">
                      <span className="font-semibold text-[var(--fg)]">Next step:</span> {c.brief.followUp}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-[13px] text-[var(--muted)]">
                    {recapReasonCopy(c.recapReason)}
                    {failed[c.id] ? <span className="ml-1 text-[var(--danger,#b42318)]">{failed[c.id]}</span> : null}
                  </div>
                  {c.canWrite ? (
                    <button
                      type="button"
                      onClick={() => void write(c.id)}
                      disabled={writing !== null}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] font-medium text-[var(--fg)] hover:bg-[var(--panel-2)] disabled:opacity-60"
                      title="Write the brief for this visit now. One credit, billed to you."
                    >
                      <SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      {writing === c.id ? "Writing…" : "Write the brief · 1 credit"}
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
