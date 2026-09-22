/**
 * The two redirects every authenticated entry point owes a signed-in visitor.
 *
 * There are two ways into this app, and only one of them was gated. `src/app/(app)/layout.tsx`
 * covers every route under the app shell; `src/app/page.tsx` — the root — sits *outside* that
 * route group and rendered `HomeAuthedClient` to anyone with a session, checking nothing. Sign in
 * and you land on `/`, which is precisely the path that asked no questions:
 *
 *   - a **queued** visitor saw the app home instead of `/waitlist`. The endpoints underneath still
 *     refuse them (`src/lib/gating/waitlist.ts`), so nothing leaked, but the screen said yes while
 *     every request said no — the same split the layout's comment describes as already fixed.
 *   - a **new account** never reached `/welcome`, because the only check lived on pages you reach
 *     *after* the first screen. First-run setup that nobody sees is not first-run setup.
 *
 * So the rule lives here and both entry points call it. A third entry point will be someone
 * forgetting this again; the defence is that there is now one function to forget rather than two
 * copies to keep in step.
 *
 * Order matters, and it is the order of the sentence somebody would say: you cannot get in yet,
 * then you have not agreed to the terms, then you have not set anything up. Nobody sets preferences
 * before agreeing, and nobody agrees before being let in. `redirect()` throws, so this must never
 * be called inside a `try` that swallows it.
 *
 * The terms step was added after the invitation flow shipped without it: approving an account let
 * it in immediately, so anyone who ignored the email in favour of signing in directly never saw
 * `/accept` and the record simply said "never accepted". `/accept` therefore has to work for a
 * signed-in visitor carrying no token at all, or this redirect is a lockout rather than a gate.
 */
import { redirect } from "next/navigation";

import { readAccessStatus } from "@/lib/gating/waitlist";
import { FIRST_RUN_PATH, userNeedsFirstRun } from "@/lib/onboarding/firstRun";
import { TERMS_ACCEPT_PATH, userNeedsTermsAcceptance } from "@/lib/onboarding/termsGate";

export async function enforceEntryGates(userId: string | null | undefined): Promise<void> {
  if (typeof userId !== "string" || !userId) return;
  if ((await readAccessStatus(userId)) === "waitlisted") redirect("/waitlist");
  // Accounts predating the field are treated as accepted; see `termsGate.ts` for why that cutoff
  // exists rather than a backfill.
  if (await userNeedsTermsAcceptance(userId)) redirect(TERMS_ACCEPT_PATH);
  // `userNeedsFirstRun` answers false for every account that existed before the screen did, so
  // this is one indexed read that says no for everyone but a genuinely new sign-in.
  if (await userNeedsFirstRun(userId)) redirect(FIRST_RUN_PATH);
}
