/**
 * Public page at `/costs`: what each AI action costs, per quality level.
 *
 * This was a modal on the Usage tab, which was cramped for a five-row table with notes. As a page it
 * can be read, linked and anchored: the Usage list links each charge straight to its row
 * (`/costs#summary`). Prices come from `COST_CATALOG`, which reads released prices from
 * `creditsForRun` — the function that charges a run — so this page cannot drift from the bill.
 */
import type { Metadata } from "next";
import Link from "next/link";

import PublicGuideShell from "@/components/connect/PublicGuideShell";
import { COST_CATALOG, FREE_ACTIONS, QUALITY_BLURBS, QUALITY_LABELS, QUALITY_TIERS, costAnchorId } from "@/lib/credits/costCatalog";
import { INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";

export const metadata: Metadata = {
  title: "What credits cost",
  description:
    "What each AI action in lnkdrp costs in credits, at basic, standard and advanced quality: the summary on every link, AI compare between versions, and what never costs credits.",
  alternates: { canonical: "/costs" },
};

/** Render the public credit cost page. */
export default function CostsPage() {
  return (
    <PublicGuideShell>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Credits</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">What credits cost</h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
        Credits are only spent when AI reads a document. Uploading, sharing, passwords, expiry and every analytic are free on
        every plan. Each run is listed on your Usage tab with the level it ran at.
      </p>

      <div className="mt-10 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">
              <th className="pb-3 pr-4 font-semibold">Per run</th>
              {QUALITY_TIERS.map((t) => (
                <th key={t} className="w-[15%] whitespace-nowrap pb-3 pl-4 text-right font-semibold">
                  {QUALITY_LABELS[t]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-white/80">
            {COST_CATALOG.map((row) => (
              <tr key={row.label} id={costAnchorId(row)} className="scroll-mt-24 align-top">
                <td className="py-4 pr-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={row.released ? "font-medium text-white/90" : "font-medium text-white/60"}>{row.label}</span>
                    {row.released ? null : (
                      <span className="whitespace-nowrap rounded-full border border-white/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-white/45">
                        Not available yet
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-white/45">{row.detail}</div>
                  {row.notes?.length ? (
                    <ul className="mt-2 space-y-1 text-[12px] leading-5 text-white/45">
                      {row.notes.map((n) => (
                        <li key={n} className="flex gap-1.5">
                          <span aria-hidden="true">·</span>
                          <span>{n}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                {QUALITY_TIERS.map((t) => (
                  <td key={t} className="whitespace-nowrap py-4 pl-4 text-right align-top tabular-nums">
                    <span className={row.released ? "text-white/90" : "text-white/45"}>{row.costs[t]}</span>{" "}
                    <span className="text-white/45">{row.costs[t] === 1 ? "credit" : "credits"}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-12 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">What the levels mean</h2>
      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        {QUALITY_TIERS.map((t) => (
          <div key={t} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <dt className="text-[15px] font-semibold text-white">{QUALITY_LABELS[t]}</dt>
            <dd className="mt-1.5 text-[13px] leading-5 text-white/55">{QUALITY_BLURBS[t]}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-12 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Never costs credits</h2>
      <ul className="mt-4 grid gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-[13px] leading-5 text-white/65 sm:grid-cols-2">
        {FREE_ACTIONS.map((f) => (
          <li key={f} className="flex gap-2">
            <span aria-hidden="true" className="text-white/35">
              ·
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-12 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-7">
        <h2 className="font-serif text-2xl tracking-tight text-white">Where credits come from</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-white/60">
          Every workspace starts with 50 starter credits, once. Pro includes {INCLUDED_CREDITS_PER_CYCLE} a month and can turn on
          on-demand credits at $0.10 each under a spend limit you set. On Free, buy a credit pack from $5.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <Link href="/credits" className="font-medium text-white underline-offset-4 hover:underline">
            Buy credits →
          </Link>
          <Link href="/pricing" className="text-white/60 underline-offset-4 hover:text-white hover:underline">
            Plans and pricing
          </Link>
        </div>
      </div>
    </PublicGuideShell>
  );
}
