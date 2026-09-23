/**
 * Page for `/credits` — buy prepaid AI credit packs (Free workspaces). A signed-in Pro workspace
 * sees its credits and on-demand usage instead of the packs: Pro adds credits with on-demand.
 *
 * Built on the pricing page's frame (same header, lighting, serif headline and cards) so buying
 * credits feels like part of the same place as choosing a plan. The packs come from
 * `src/lib/credits/packs.ts`; the white Pro card underneath makes the honest comparison, since a
 * month of Pro costs less than the largest pack.
 */
import type { Metadata } from "next";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { getBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { CREDIT_PACKS, PURCHASED_CREDITS_EXPIRY_MONTHS } from "@/lib/credits/packs";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { enforceEntryGates } from "@/lib/gating/entryGate";
import CreditsPurchaseClient from "./CreditsPurchaseClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Buy AI credits",
  description: `Prepaid AI credit packs for LinkDrop: ${CREDIT_PACKS.map((p) => p.credits).join(", ")} credits, used after your included credits and valid for ${PURCHASED_CREDITS_EXPIRY_MONTHS} months.`,
};

async function readProPriceLabel(): Promise<string | null> {
  try {
    const { proPriceLabel } = await getBillingProPriceLabel();
    return proPriceLabel;
  } catch {
    return null;
  }
}

export default async function CreditsPage() {
  // Outside the `(app)` route group, so the entry gates are called here or not at all. This page
  // sells credits, which makes it the worst of the three to leave open: a queued visitor reaching
  // it is refused by `POST /api/credits/purchase` but only after being shown a price list.
  const session = await getServerSession(authOptions);
  await enforceEntryGates(session?.user?.id);

  const proPriceLabel = await readProPriceLabel();

  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
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
          <div className="max-w-2xl">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Credits</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
              More credits,
              <br className="hidden sm:block" /> when you need them.
            </h1>
            <p className="mt-6 max-w-lg text-sm leading-6 text-white/60 sm:text-base">
              Credits pay for AI summaries and AI compare. On Free, buy a pack once: the credits land in your
              workspace right away and last {PURCHASED_CREDITS_EXPIRY_MONTHS} months. On Pro, on-demand usage keeps
              AI running past your monthly credits.
            </p>
          </div>

          <CreditsPurchaseClient packs={[...CREDIT_PACKS]} proPriceLabel={proPriceLabel} proCredits={INCLUDED_CREDITS_PER_CYCLE} freeCredits={FREE_STARTER_CREDITS} />

          <div className="mt-20 grid gap-10 md:grid-cols-3 md:gap-8">
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">What a credit buys</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                The summary on every link is one credit, or free when your agent writes it. AI compare between two
                versions is 2, 5 or 12 credits by level. Links, uploads, replacements and stats never use credits.
              </p>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">Used last, kept a year</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Starter and monthly Pro credits are spent first, so a pack only goes down once those are gone. Whatever
                is left of a pack expires {PURCHASED_CREDITS_EXPIRY_MONTHS} months after you buy it, oldest pack
                first.
              </p>
            </div>
            <div>
              <h2 className="font-serif text-2xl tracking-tight text-white">No daily limit</h2>
              <p className="mt-3 text-sm leading-6 text-white/60">
                Free workspaces use at most 15 credits a day. Buying any pack lifts that for your workspace, so the
                credits you paid for are there when a busy day needs them.
              </p>
            </div>
          </div>
        </section>

        <PublicFooter className="relative pb-6" />
      </div>
    </main>
  );
}
