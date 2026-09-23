/**
 * `POST /api/support/plain/customer-cards` — the customer-card API Plain calls when a support
 * thread opens (https://www.plain.com/docs/customer-cards/protocol).
 *
 * Plain sends `{ cardKeys, customer: { id, email, externalId }, thread? }` signed with
 * `Plain-Request-Signature`; we answer `{ cards: [...] }` with one card per requested key.
 *
 * This is not an admin route and not a user route: the caller is Plain, authenticated by the
 * HMAC over the body, and the customer is whoever the ticket is from. It reads a lot about that
 * customer, so the signature is checked before the body is even parsed, and a missing secret
 * closes the door rather than opening it (see `signature.ts`).
 *
 * Plain gives us 15 s. `loadCustomerContext` runs the per-workspace lookups in parallel and
 * caps workspaces and errors, so a heavy account stays well inside that.
 */
import { NextResponse } from "next/server";

import { buildCards, loadCustomerContext } from "@/lib/support/plain/cards";
import { configuredPlainSigningSecret, PLAIN_SIGNATURE_HEADER, verifyPlainSignature } from "@/lib/support/plain/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CardRequest = { cardKeys?: unknown; customer?: { email?: unknown } | null };

/** Verify the signature, resolve the customer by email, answer one card per key. */
export async function POST(request: Request) {
  const secret = configuredPlainSigningSecret();
  if (!secret) {
    return NextResponse.json({ error: "PLAIN_REQUEST_SIGNING_SECRET is not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifyPlainSignature(rawBody, request.headers.get(PLAIN_SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  let body: CardRequest | null = null;
  try {
    body = JSON.parse(rawBody) as CardRequest;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const cardKeys = Array.isArray(body?.cardKeys) ? body.cardKeys.filter((k): k is string => typeof k === "string" && k.length > 0) : [];
  const email = typeof body?.customer?.email === "string" ? body.customer.email : "";
  if (cardKeys.length === 0) return NextResponse.json({ cards: [] });
  if (!email) {
    return NextResponse.json({ cards: buildCards(cardKeys, { found: false, email: "" }) });
  }

  const ctx = await loadCustomerContext(email);
  return NextResponse.json({ cards: buildCards(cardKeys, ctx) });
}
