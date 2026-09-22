/**
 * Layout for `/preferences/*` — standalone preferences shell (no app sidebar).
 *
 * Outside the `(app)` route group, so the three entry gates had to be called here explicitly or not
 * at all; they were not. See `src/app/dashboard/layout.tsx`, which had the same hole for the same
 * reason, and `entryGate.ts` for why there is one function rather than three copies.
 */
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { enforceEntryGates } from "@/lib/gating/entryGate";
import PreferencesShell from "./preferencesShell";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  await enforceEntryGates(session?.user?.id);
  return <PreferencesShell>{children}</PreferencesShell>;
}


