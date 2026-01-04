/**
 * Page for `/billing/success` — shown after Stripe Checkout redirects back.
 *
 * IMPORTANT: We do NOT grant access based on this redirect. The page polls `/api/billing/status`
 * until Stripe webhooks have updated MongoDB.
 */
import { StandaloneBrandedShell } from "@/components/StandaloneBrandedShell";
import SuccessClient from "./successClient";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function BillingSuccessPage(props: { searchParams?: Promise<SearchParams> | SearchParams }) {
  // Next.js (App Router) provides `searchParams` as an async value in newer versions.
  // Unwrap it before reading properties to avoid the "sync dynamic APIs" warning.
  const sp = (await props.searchParams) ?? {};

  const raw = sp.session_id;
  const sessionId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  const demoRaw = sp.demo;
  const demo = typeof demoRaw === "string" ? demoRaw : Array.isArray(demoRaw) ? demoRaw[0] : "";
  return (
    <StandaloneBrandedShell kicker="Billing">
      <SuccessClient sessionId={sessionId} demo={demo} />
    </StandaloneBrandedShell>
  );
}


