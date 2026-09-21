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
 * Order matters: the queue comes first, because somebody who cannot get in yet has nothing to set
 * up. `redirect()` throws, so this must never be called inside a `try` that swallows it.
 */
import { redirect } from "next/navigation";

import { readAccessStatus } from "@/lib/gating/waitlist";
import { FIRST_RUN_PATH, userNeedsFirstRun } from "@/lib/onboarding/firstRun";

export async function enforceEntryGates(userId: string | null | undefined): Promise<void> {
  if (typeof userId !== "string" || !userId) return;
  if ((await readAccessStatus(userId)) === "waitlisted") redirect("/waitlist");
  // `userNeedsFirstRun` answers false for every account that existed before the screen did, so
  // this is one indexed read that says no for everyone but a genuinely new sign-in.
  if (await userNeedsFirstRun(userId)) redirect(FIRST_RUN_PATH);
}
