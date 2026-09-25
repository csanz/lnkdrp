/**
 * Page for `/billing/success` — where Stripe Checkout sends someone back after upgrading.
 *
 * IMPORTANT: We do NOT grant access based on this redirect. The page polls `/api/billing/status`
 * until Stripe webhooks have updated MongoDB.
 *
 * It lives in the same visual world as `/pricing` and `/credits` (near-black ground, soft light,
 * serif display, the white card that stands for Pro) because it is the last step of that journey:
 * someone chose the white Pro card on the pricing page, paid, and lands here holding it. It used to
 * be a small generic panel in the app's standalone shell, which made the moment after paying feel
 * like an error page.
 */
import PublicHeader from "@/components/PublicHeader";
import { INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { PRO_INCLUDED_COLLABORATORS } from "@/lib/billing/planLimits";
import SuccessClient from "./successClient";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BillingSuccessPage(props: { searchParams?: Promise<SearchParams> }) {
  // Next 15+ hands `searchParams` over as a promise, and the production build's page type check
  // refuses a union with the plain object (the old accepted-either signature failed `next build`).
  const sp = (await props.searchParams) ?? {};

  const raw = sp.session_id;
  const sessionId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  const demoRaw = sp.demo;
  const demo = typeof demoRaw === "string" ? demoRaw : Array.isArray(demoRaw) ? demoRaw[0] : "";

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
        <section className="mx-auto w-full max-w-4xl flex-1 px-8 pb-20 pt-12 sm:px-10 md:pt-16">
          <SuccessClient
            sessionId={sessionId}
            demo={demo}
            proCredits={INCLUDED_CREDITS_PER_CYCLE}
            proCollaborators={PRO_INCLUDED_COLLABORATORS}
          />
        </section>
      </div>
    </main>
  );
}
