/**
 * Page for `/billing/success` — shown after Stripe Checkout redirects back.
 *
 * IMPORTANT: We do NOT grant access based on this redirect. The page polls `/api/billing/status`
 * until Stripe webhooks have updated MongoDB.
 */
import SuccessClient from "./successClient";

export default function BillingSuccessPage(props: { searchParams?: Record<string, string | string[] | undefined> }) {
  const raw = props.searchParams?.session_id;
  const sessionId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
  return <SuccessClient sessionId={sessionId} />;
}


