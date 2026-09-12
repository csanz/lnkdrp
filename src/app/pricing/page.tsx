/**
 * Public pricing page.
 *
 * Free vs Pro side by side. Links, projects, analytics and collaborators are the product; AI
 * summaries and version compares are included on every plan (2026-09-12 decision, see
 * docs/prds/lnkdrp-credit-features.md), so there is no credit table here. The Pro price label is
 * the same MongoDB-backed value the dashboard shows.
 *
 * Plan limits are imported from `src/lib/billing/planLimits.ts`, the same module the API routes
 * enforce with, so the numbers here always match what users hit.
 */
import type { Metadata } from "next";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import {
  FREE_ACTIVE_LINKS,
  FREE_ANALYTICS_DAYS,
  FREE_PROJECTS,
  PRO_INCLUDED_COLLABORATORS,
} from "@/lib/billing/planLimits";
import { getBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { cn } from "@/lib/cn";
import PricingCta from "./PricingCta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Three links free, forever. Upgrade when your agent needs more.",
};

/** Plan limits come from `planLimits.ts` (the enforcement source of truth) so the copy cannot drift. */
const EXTRA_COLLABORATOR_LABEL = "$5/mo";

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
              Three links free. Upgrade when your agent needs more.
            </h1>
            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              You pay for links, projects, and the people you work with. The AI that makes each link
              worth opening, the summary and the version compare, is included on every plan.
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
                  `${FREE_ACTIVE_LINKS} active share links`,
                  `${FREE_PROJECTS} project`,
                  `Last ${FREE_ANALYTICS_DAYS} days of viewer analytics`,
                  "AI summary and key points on every link",
                  "Version history and compare",
                  "Password protection and download control",
                  "Works with Claude Code, Cursor, Codex, and any MCP client",
                  "Single user",
                ]}
              />
              <div className="mt-8 flex-1" />
              <PricingCta plan="free" variant="dark" helper="Sign in with Google. No card needed." />
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
                For teams and agents that send documents every day.
              </p>
              <FeatureList
                muted="text-black/80"
                items={[
                  "Unlimited active share links",
                  "Unlimited projects",
                  "Full viewer analytics history",
                  "Collaborators on one shared workspace",
                  "Agents never take a seat",
                  "AI summary and key points on every link",
                  "Version history and compare",
                  "Password protection and download control",
                  "Works with Claude Code, Cursor, Codex, and any MCP client",
                ]}
              />
              <div className="mt-8 flex-1" />
              <PricingCta plan="pro" variant="light" helper="Stripe checkout · Invoices in the portal · Cancel anytime, Pro stays active until the cycle ends" />
            </div>
          </div>

          {/* Enterprise: sold, not bought. No price; every item here is delivered by hand at first. */}
          <div className="mt-6 rounded-3xl border border-white/10 bg-white/[0.03] px-7 py-7 md:px-9">
            <div className="grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_auto] md:items-center">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">Enterprise</div>
                <h2 className="mt-2 font-serif text-2xl leading-snug tracking-tight text-white">
                  Your domain, your seats, and someone to call.
                </h2>
                <p className="mt-2 text-sm leading-6 text-white/60">
                  For teams that send documents at volume and need the paperwork to match.
                </p>
              </div>
              <ul className="grid gap-x-8 gap-y-2.5 text-sm leading-6 text-white/75 sm:grid-cols-2">
                {[
                  "Share links on your own domain",
                  "As many seats as you need, one invoice",
                  "Private workspaces per team, one admin view",
                  "Higher file size and retention limits",
                  "Priority support and a DPA",
                  "Everything in Pro",
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="md:min-w-[200px]">
                <a
                  href="mailto:hi@lnkdrp.com?subject=LinkDrop%20Enterprise"
                  className="inline-flex w-full items-center justify-center rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  Talk to us
                </a>
                <div className="mt-2 text-center text-[11px] leading-5 text-white/40">
                  Pricing based on seats and volume. We reply within a business day.
                </div>
              </div>
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
                Every open is recorded: who it was, how long they stayed, which pages held them, and
                whether they downloaded. Free keeps the last {FREE_ANALYTICS_DAYS} days. Pro keeps the whole
                history.
              </p>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">Built for agents</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Claude Code, Cursor, Codex, or any MCP client can create links and read the numbers on
                every plan. Connect five agents and it costs nothing: seats count humans, not the
                software working for them, and agents live under the same limits so nothing surprises you.
              </p>
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-20 max-w-3xl">
            <h2 className="font-serif text-3xl tracking-tight text-white">Questions</h2>
            <dl className="mt-6 divide-y divide-white/10 border-y border-white/10">
              {[
                {
                  q: "What counts as an active link?",
                  a: "A document with sharing switched on. Turn sharing off and the link stops resolving and no longer counts. Your document and its stats stay in your workspace.",
                },
                {
                  q: "What happens when I hit the Free limit?",
                  a: "Existing links keep working. To share a new document you disable an old link or upgrade the workspace to Pro. Your agent gets the same answer over MCP, so it can tell you.",
                },
                {
                  q: "Is Pro per person or per workspace?",
                  a: `Per workspace. Upgrade a workspace once and every link, project, and member in it is on Pro. The base price includes ${PRO_INCLUDED_COLLABORATORS} collaborator; additional seats are added per member from your workspace settings.`,
                },
                {
                  q: "I already have more than 3 links. What happens?",
                  a: "Nothing changes right away. Workspaces that were over the Free limits at launch get a 14-day grace period with reminders; after that, new links and projects wait until you disable some or upgrade. Existing links never stop working.",
                },
                {
                  q: "Do I need credits for the AI?",
                  a: "No. The summary on every link and the version compare are included on both plans. If we add AI features that cost credits, they will be listed here with a fixed price before they run.",
                },
                {
                  q: "Which files can I share?",
                  a: "PDF today. Every link opens in our viewer with the AI summary attached, on any device, no app needed.",
                },
                {
                  q: "How do I cancel?",
                  a: "From the billing portal, any time. Pro stays active until the end of the paid cycle, then the workspace goes back to Free and the Free limits apply again.",
                },
              ].map((item) => (
                <div key={item.q} className="grid gap-2 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:gap-8">
                  <dt className="text-sm font-medium text-white">{item.q}</dt>
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
