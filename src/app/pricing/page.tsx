/**
 * Public pricing page.
 *
 * Free vs Pro side by side, then the credit schedule so the cost of each AI action is visible
 * before anyone signs in. Numbers come from the billing/credits modules rather than being retyped
 * here, and the Pro price label is the same MongoDB-backed value the dashboard shows.
 */
import type { Metadata } from "next";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { getBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { creditsForRun } from "@/lib/credits/schedule";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { cn } from "@/lib/cn";
import PricingCta from "./PricingCta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Start free. Upgrade to Pro when your agent gets busy. Links and tracking never cost credits.",
};

const ON_DEMAND_RATE = `$${(USD_CENTS_PER_CREDIT / 100).toFixed(2)}`;

const TIERS = ["basic", "standard", "advanced"] as const;
const ACTIONS = [
  { key: "summary", label: "Summary", note: "Runs on every upload" },
  { key: "review", label: "Review", note: "Deeper read, on request" },
  { key: "history", label: "History compare", note: "When you replace a document" },
] as const;

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
              Start free. Upgrade when your agent gets busy.
            </h1>
            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              Share links, click tracking, and stats never cost anything, from the dashboard or from your
              agent. Credits only pay for the AI work: summaries, reviews, and history comparisons.
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
                Everything you need to send a document and see who opened it.
              </p>
              <FeatureList
                muted="text-white/75"
                items={[
                  `${FREE_STARTER_CREDITS} starter credits, one time`,
                  "Unlimited share links and tracking",
                  "Views, clicks, and stats from your agent or the dashboard",
                  "Password protection and download control",
                  "Team workspaces, invite as many teammates as you like",
                  "MCP, API, and CLI access",
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
                  Most popular
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
                For people who send documents every day and want the AI on every one of them.
              </p>
              <FeatureList
                muted="text-black/80"
                items={[
                  `${INCLUDED_CREDITS_PER_CYCLE} credits every billing cycle`,
                  "Everything in Free",
                  "Covers the whole workspace: every teammate and their agents share one credit pool",
                  `On-demand credits at ${ON_DEMAND_RATE} each, with a hard spend limit you set`,
                  "Invoices and payment method in the billing portal",
                  "Cancel anytime, keeps working until the cycle ends",
                ]}
              />
              <div className="mt-8 flex-1" />
              <PricingCta plan="pro" variant="light" helper="Sign in with Google first. Checkout is handled by Stripe." />
            </div>
          </div>

          {/* Credit schedule */}
          <div className="mt-20 grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-14">
            <div>
              <h2 className="font-serif text-3xl tracking-tight text-white">What a credit buys</h2>
              <p className="mt-4 text-sm leading-6 text-white/60">
                Every AI action has a fixed price in credits, so the cost is known before it runs. Pick the
                quality tier per document, or let your agent decide.
              </p>
              <p className="mt-4 text-sm leading-6 text-white/60">
                Creating links, changing settings, and reading stats are free. Your agent pays the same as
                the dashboard, no markup for MCP.
              </p>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
                    <th scope="col" className="px-5 py-4 text-left font-semibold">
                      Action
                    </th>
                    {TIERS.map((tier) => (
                      <th key={tier} scope="col" className="px-5 py-4 text-right font-semibold capitalize">
                        {tier}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ACTIONS.map((action) => (
                    <tr key={action.key} className="border-t border-white/10">
                      <th scope="row" className="px-5 py-4 text-left font-medium text-white">
                        {action.label}
                        <div className="mt-0.5 text-xs font-normal text-white/45">{action.note}</div>
                      </th>
                      {TIERS.map((tier) => (
                        <td key={tier} className="px-5 py-4 text-right tabular-nums text-white/80">
                          {creditsForRun({ actionType: action.key, qualityTier: tier })}
                          <span className="ml-1 text-xs text-white/40">cr</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="border-t border-white/10">
                    <th scope="row" className="px-5 py-4 text-left font-medium text-white">
                      Links, tracking, stats
                      <div className="mt-0.5 text-xs font-normal text-white/45">Dashboard, MCP, API, CLI</div>
                    </th>
                    <td colSpan={3} className="px-5 py-4 text-right text-white/80">
                      Free
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-20 max-w-3xl">
            <h2 className="font-serif text-3xl tracking-tight text-white">Questions</h2>
            <dl className="mt-6 divide-y divide-white/10 border-y border-white/10">
              {[
                {
                  q: "When do Pro credits reset?",
                  a: `You get ${INCLUDED_CREDITS_PER_CYCLE} credits at the start of each billing cycle, on your subscription anniversary rather than the calendar month. Unused credits do not roll over.`,
                },
                {
                  q: "What happens when I run out?",
                  a: "Links keep working and stats keep flowing. AI actions pause until the next cycle, or until you turn on on-demand credits. On-demand is off by default and always capped by a limit you set.",
                },
                {
                  q: "Is Pro per person or per workspace?",
                  a: "Per workspace, with no per-seat fee. Invite your team to a workspace, upgrade it once, and everyone in it, along with their agents, draws from the same credit pool. Your personal workspace stays on whatever plan it has.",
                },
                {
                  q: "Does my agent cost more than the dashboard?",
                  a: "No. A summary, review, or comparison costs the same number of credits whether it was started from the dashboard or from an agent over MCP.",
                },
                {
                  q: "How do I cancel?",
                  a: "From the billing portal, any time. Pro stays active until the end of the paid cycle, then the workspace goes back to Free.",
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
