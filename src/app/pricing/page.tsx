/**
 * Public pricing page.
 *
 * Free vs Pro side by side. Links, projects, analytics and collaborators are the product; the AI
 * summary and AI compare cost credits on every plan (summary 1/2/5, compare 2/5/12 by tier); letting
 * recipients browse versions is the Pro version feature (2026-09-13 decision, see
 * docs/prds/lnkdrp-credit-features.md). A compact "How credits work"
 * block explains the per-action prices without a full credit table. The Pro price label is the
 * same MongoDB-backed value the dashboard shows.
 *
 * Plan limits are imported from `src/lib/billing/planLimits.ts`, the same module the API routes
 * enforce with, so the numbers here always match what users hit.
 */
import type { Metadata } from "next";
import { waitlistEnabled } from "@/lib/waitlist/waitlist";
import Link from "next/link";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import {
  FREE_DOCUMENTS,
  FREE_ANALYTICS_DAYS,
  FREE_PROJECTS,
  PRO_INCLUDED_COLLABORATORS,
} from "@/lib/billing/planLimits";
import { getBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { comparesFor, plural } from "@/lib/client/planNumbers";
import { CREDIT_PACKS, formatPackPrice } from "@/lib/credits/packs";
import { CREDITS_COPY, whatHappensAfterFreeCredits } from "@/lib/client/planLimit";
import { cn } from "@/lib/cn";
import PricingCta from "./PricingCta";

/** "from $7": the entry pack, never retyped. */
const CHEAPEST_PACK_PRICE = formatPackPrice(Math.min(...CREDIT_PACKS.map((p) => p.priceCents)));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Free to send a few. Pro to send every day. ${FREE_DOCUMENTS} shared documents free, forever, each with unlimited links; deep analytics and ${INCLUDED_CREDITS_PER_CYCLE} AI credits a month on Pro.`,
};

/** Read the Pro price label without letting a database hiccup take the page down. */
async function readProPriceLabel(): Promise<string | null> {
  try {
    const { proPriceLabel } = await getBillingProPriceLabel();
    return proPriceLabel;
  } catch {
    return null;
  }
}

/** Small inline checkmark for feature lists. */
function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="mt-[3px] h-3.5 w-3.5 shrink-0">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Bulleted feature list; `muted` sets the text color so it works on dark and light cards. */
function FeatureList({ items, muted }: { items: string[]; muted: string }) {
  return (
    <ul className="mt-6 space-y-2.5 text-sm leading-6">
      {items.map((item) => (
        <li key={item} className={cn("flex gap-2.5", muted)}>
          <Check />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Render the PricingPage UI.
 */
export default async function PricingPage() {
  const proPriceLabel = await readProPriceLabel();

  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Same soft lighting as the other public pages. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />

        <section className="mx-auto w-full max-w-6xl flex-1 px-8 pb-20 pt-12 sm:px-10 md:pt-16 lg:px-12">
          {/* Intro */}
          <div className="max-w-2xl">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Pricing</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
              Free to send a few.{" "}
              <br className="hidden sm:block" />
              Pro to send every day.
            </h1>
            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              You pay for links, projects, and the people you work with. Every link opens with an AI
              summary, one credit each, or free when your agent writes it. Version history and AI compare run on credits too.
            </p>
          </div>

          {/* Plans */}
          <div className="mt-12 grid gap-4 md:grid-cols-2 md:gap-5">
            {/* Free */}
            <div className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
              {/* min-h matches the Pro badge row so both cards' price lines and buttons align. */}
              <div className="flex min-h-[24px] items-center text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
                Free
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="font-serif text-5xl tracking-tight text-white">$0</span>
                <span className="text-sm text-white/50">forever</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Send a deck and see who opened it. Your agent can do the sending.
              </p>
              <FeatureList
                muted="text-white/75"
                items={[
                  `${FREE_DOCUMENTS} shared documents, each with unlimited share links`,
                  plural(FREE_PROJECTS, "project"),
                  `Basic analytics: views and downloads, last ${FREE_ANALYTICS_DAYS} days`,
                  "AI summary on every link, 1 credit; free when your agent writes it",
                  "Version history, with AI compare from 2 credits",
                  "Password protection and download control",
                  "Built for Claude Code, Cursor, Codex, and any MCP client",
                  `${FREE_STARTER_CREDITS} credits to start, one time`,
                  "Single user",
                ]}
              />
              <p className="mt-4 text-[12px] leading-5 text-white/45">
                Archive a document any time to free up a slot. Once your starter credits run out,{" "}
                {whatHappensAfterFreeCredits()}; Free uses at most {CREDITS_COPY.freeDailyCap} credits a day.
              </p>
              <div className="mt-8 flex-1" />
              {/*
                The helper has to know about the queue. It said "Sign in with Google" full stop,
                while every new account was being queued - so the page sold immediate access and
                the click delivered a waiting list.
              */}
              <PricingCta
                plan="free"
                variant="dark"
                helper={
                  waitlistEnabled()
                    ? `Early access: sign in to request an account. ${FREE_STARTER_CREDITS} free credits once you are in. No card needed.`
                    : `Sign in with Google. ${FREE_STARTER_CREDITS} free credits to try the AI features. No card needed.`
                }
              />
            </div>

            {/* Pro */}
            <div className="relative flex flex-col rounded-2xl border border-transparent bg-white p-7 text-black shadow-[0_30px_80px_-30px_rgba(255,255,255,0.25)] sm:p-8">
              <div className="flex min-h-[24px] items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-black/55">Pro</div>
                <span className="rounded-full bg-black px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                  Per workspace
                </span>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                {proPriceLabel ? (
                  <span className="font-serif text-5xl tracking-tight text-black">{proPriceLabel}</span>
                ) : (
                  <>
                    <span className="font-serif text-5xl tracking-tight text-black">Monthly</span>
                    <span className="text-sm text-black/50">price shown at checkout</span>
                  </>
                )}
              </div>
              <p className="mt-3 text-sm leading-6 text-black/60">
                For workspaces and agents that send documents every day.
              </p>
              <FeatureList
                muted="text-black/80"
                items={[
                  "Unlimited documents and share links",
                  "Unlimited projects",
                  "Deep analytics: who opened it, time per page, full history",
                  "Recipients can browse every version and see what changed",
                  `${INCLUDED_CREDITS_PER_CYCLE} credits a month, about ${comparesFor(INCLUDED_CREDITS_PER_CYCLE)} AI compares at standard quality`,
                  `${PRO_INCLUDED_COLLABORATORS} collaborator included · more on request`,
                  "Agents never take a seat",
                  "AI summary on every link, 1 credit; free when your agent writes it",
                  "Password protection and download control",
                  "Built for Claude Code, Cursor, Codex, and any MCP client",
                ]}
              />
              <div className="mt-8 flex-1" />
              <PricingCta plan="pro" variant="light" helper="Stripe checkout · Cancel anytime, Pro stays active until the billing period ends" />
            </div>
          </div>

          {/* What is included, and why */}
          <div className="mt-20 grid gap-10 md:grid-cols-3 md:gap-8">
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">Share with context</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Every link opens with a summary and the key points, so the reader knows what they are looking
                at before they commit the time. Password-protect it, allow or block downloads, and replace
                the file without changing the link.
              </p>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">Know who read it</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Every open is recorded. Free shows how many people opened it and the totals for the last{" "}
                {FREE_ANALYTICS_DAYS} days. Pro shows who they were, how long they spent on each page, whether
                they came back, and the whole history.
              </p>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">Built for agents</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Claude Code, Cursor, Codex, or any MCP client creates links and reads the numbers on
                every plan, through the MCP that ships with launch. Connect five agents and it costs nothing: seats count humans, not the
                software working for them, and agents live under the same limits so nothing surprises you.
              </p>
            </div>
          </div>

          {/* How credits work: tier table. Costs mirror creditsForRun in src/lib/credits/schedule.ts. */}
          <div className="mt-16 rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
            <div className="grid gap-6 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] md:gap-14">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">How credits work</div>
                <h2 className="mt-2 max-w-md text-balance font-serif text-2xl leading-snug tracking-tight text-white sm:text-[26px]">
                  Pick a level, pay per run.
                </h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-white/60">
                  Pro includes {INCLUDED_CREDITS_PER_CYCLE} credits a month: about{" "}
                  {comparesFor(INCLUDED_CREDITS_PER_CYCLE, "basic")} basic compares,{" "}
                  {comparesFor(INCLUDED_CREDITS_PER_CYCLE)} standard, or{" "}
                  {comparesFor(INCLUDED_CREDITS_PER_CYCLE, "advanced")} advanced. Higher levels run a deeper analysis and cost more per run. The summary on every
                  link is one credit, so a busy month of uploads still leaves most of the allowance. Links,
                  uploads, replacements and stats never need credits.
                </p>
                <p className="mt-3 max-w-md text-[12px] leading-5 text-white/45">
                  Need more?{" "}
                  <Link href="/credits" className="underline underline-offset-4 hover:text-white/70">
                    Buy a credit pack
                  </Link>{" "}
                  from {CHEAPEST_PACK_PRICE} on Free. On Pro, turn on on-demand instead: $0.10 per credit, billed through Stripe,
                  under a hard spend limit you set. Unused included credits do not roll over.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[26rem] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">
                      <th className="pb-3 pr-4 font-semibold">Per run</th>
                      <th className="w-[15%] whitespace-nowrap pb-3 pr-4 text-right font-semibold">Basic</th>
                      <th className="w-[15%] whitespace-nowrap pb-3 pr-4 text-right font-semibold">Standard</th>
                      <th className="w-[15%] whitespace-nowrap pb-3 text-right font-semibold">Advanced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10 text-white/80">
                    {[
                      { label: "Summary and key points", sub: "Automatic on every link, at the basic level", costs: ["1", "2", "5"], soon: false },
                      { label: "AI compare", sub: "What changed between two versions", costs: ["2", "5", "12"], soon: false },
                      { label: "AI review", sub: "Scores a document someone sent you against the criteria you set, and explains the score. Priced per document.", costs: ["2", "5", "12"], soon: true },
                      { label: "Viewer follow-up briefs", sub: "A short brief on one viewer: which pages they lingered on, whether they came back, and a suggested next step. Priced per brief.", costs: ["1", "1", "1"], soon: true },
                      { label: "Recipient Q&A", sub: "Readers ask the document questions on the share page. You set a cap per reader and per link, so nobody can run up your credits. Priced per answered question.", costs: ["1", "2", "5"], soon: true },
                    ].map((row) => (
                      <tr key={row.label} className={row.soon ? "text-white/45" : undefined}>
                        <td className="py-3 pr-6 align-top">
                          <div className={row.soon ? "font-medium text-white/60" : "font-medium text-white/90"}>{row.label}</div>
                          <div className="text-[12px] text-white/45">
                            {row.soon ? <span className="mr-1.5 whitespace-nowrap rounded-full border border-white/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-white/45">Not released yet</span> : null}
                            {row.sub}
                          </div>
                        </td>
                        {row.costs.map((c, i) => (
                          <td key={i} className={["whitespace-nowrap py-3 text-right tabular-nums align-top", i < 2 ? "pr-4" : ""].join(" ")}>
                            {c === "Included" ? (
                              <span className="text-white/50">Included</span>
                            ) : (
                              <span>
                                {c} <span className="text-white/45">{c === "1" ? "credit" : "credits"}</span>
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-[12px] leading-5 text-white/45">
                  Summaries cost 0 credits when your own agent writes them through MCP or the API, and for files
                  recipients upload through a request or replace link. Out of credits? Uploads and links still
                  work; the summary is skipped and you can write it later from the document page.
                </p>
                <p className="mt-2 text-[12px] leading-5 text-white/45">
                  Pricing change, September 13, 2026: the automatic AI summary now costs 1 credit. It was
                  previously included. Starter credits already granted are kept in full.
                </p>
              </div>
            </div>
          </div>

          {/* Enterprise: sold, not bought. No price; every item here is delivered by hand at first. */}
          <div className="mt-16 rounded-2xl border border-white/10 bg-white/[0.03] p-7 sm:p-8">
            <div className="grid gap-6 md:grid-cols-2 md:gap-[84px]">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">Enterprise</div>
                <h2 className="mt-2 max-w-md text-balance font-serif text-2xl leading-snug tracking-tight text-white sm:text-[26px]">
                  Your domain, your seats, and someone to call.
                </h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-white/60">
                  For companies that send documents at volume and need the paperwork to match.
                </p>
              </div>
              <div className="flex flex-col justify-end">
                <a
                  href="mailto:hi@lnkdrp.com?subject=LinkDrop%20Enterprise"
                  className="inline-flex w-full items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90"
                >
                  Talk to us
                </a>
                <div className="mt-3 text-center text-[11px] leading-[1.4] text-white/40">
                  Priced on seats and volume · We reply within a business day
                </div>
              </div>
            </div>
            <ul className="mt-7 grid gap-x-8 gap-y-3 border-t border-white/10 pt-6 text-sm leading-6 text-white/75 sm:grid-cols-2 md:grid-cols-3">
              {[
                "Share links on your own domain",
                "Single sign-on (SAML or OIDC)",
                "Unlimited seats, one invoice",
                "Private workspaces, one admin view",
                "Priority support and a DPA",
                "Verified access for sensitive links",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <Check />
                  {/* Wrapping, not nowrap. The list is one column on a phone, so an unbreakable
                      feature line sets the card's width and pushes the whole page sideways. The
                      nowrap was protecting a multi-column desktop layout that no longer applies
                      once the grid has stacked. */}
                  <span className="sm:whitespace-nowrap">{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* FAQ */}
          <div className="mt-20 max-w-3xl">
            <h2 className="font-serif text-3xl tracking-tight text-white">Questions</h2>
            <dl className="mt-6 divide-y divide-white/10 border-y border-white/10">
              {[
                {
                  q: "What counts toward the Free limit?",
                  a: "A document with sharing switched on. Turn sharing off, or archive the document, and the link stops resolving and no longer counts. Your document and its stats stay in your workspace, and you can bring it back any time a slot is free.",
                },
                {
                  q: "What happens when I hit the Free limit?",
                  a: "Existing links keep working. To share a new document, archive an old one or turn its sharing off to free the slot, or upgrade the workspace to Pro. Archived documents keep their stats and can come back whenever a slot is free.",
                },
                {
                  q: "Can I create more than one link for a document?",
                  // Interpolated, like every other number on this page. Typed by hand it said 3
                  // eight lines under a card saying 10 - the cap was 3 when the sentence was
                  // written, and the commit that raised it swept the interpolated copy and could
                  // not see this one.
                  a: `Yes. Give a document a link per audience: one per investor, one per counterparty. Each link carries its own label, password, download switch, expiry and stats, and you never upload the file again. Links are not capped on any plan. Free counts shared documents (${FREE_DOCUMENTS}), not the links on them, so three investor links on one deck use one slot.`,
                },
                {
                  q: "Is Pro per person or per workspace?",
                  a: `Per workspace. Upgrade a workspace once and every link, project, and member in it is on Pro. The base price includes ${PRO_INCLUDED_COLLABORATORS} collaborator; contact us to add more seats to a workspace.`,
                },
                {
                  q: `I already have more than ${FREE_DOCUMENTS} shared documents. What happens?`,
                  a: "Nothing changes right away. Workspaces that were over the Free limits at launch get a 14-day grace period with reminders; after that, new documents and projects wait until you archive some or upgrade. Existing links never stop working, and you can keep adding links to the documents you already have. Links are not capped on any plan.",
                },
                {
                  q: "What do credits pay for?",
                  a: `AI runs. Links, uploads, replacements and stats never need credits. The summary and key points written for every upload cost 1 credit at the basic level they run at automatically. They cost 0 when your own agent writes the summary through MCP or the API, and for files recipients upload through a request or replace link. AI compare of two versions: 2 credits for basic, 5 for standard, 12 for advanced. Every Free workspace, personal or team, starts with ${FREE_STARTER_CREDITS} credits, one time, and uses at most ${CREDITS_COPY.freeDailyCap} credits a day; once they run out, ${whatHappensAfterFreeCredits()}. Pro includes ${INCLUDED_CREDITS_PER_CYCLE} credits a month, which reset monthly and do not roll over; if you turn on on-demand, extra credits are $0.10 each, billed monthly through Stripe under a hard spend limit you set.`,
                },
                {
                  q: "What happens when I run out of credits?",
                  a: `Uploads still complete and links keep working. The AI summary is skipped, and you can write it later from the document page for 1 credit. AI compare and other AI actions stop until you add credits. On Free, ${whatHappensAfterFreeCredits()}. On Pro, turn on on-demand usage or wait for the next billing cycle.`,
                },
                {
                  q: "Can I replace a file on Free?",
                  a: "Yes. Replacing keeps the same link, recipients always see the latest file, and it never uses credits. Your version history and AI compare work on Free and use credits; the version list recipients can browse is Pro.",
                },
                {
                  q: "Which files can I share?",
                  a: "PDF today. Every link opens in our viewer with the AI summary attached, on any device, no app needed.",
                },
                {
                  q: "How do I cancel?",
                  a: "From the billing portal, any time. Pro stays active until the end of the paid period, then the workspace goes back to Free and the Free limits apply again.",
                },
              ].map((item) => (
                <div key={item.q} className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:gap-8">
                  <dt className="text-sm font-medium leading-6 text-white">{item.q}</dt>
                  <dd className="text-sm leading-6 text-white/60">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <PublicFooter className="relative pb-6" />
      </div>
    </main>
  );
}
