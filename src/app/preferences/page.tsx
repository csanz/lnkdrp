/**
 * `/preferences` redirects to the dashboard.
 *
 * This was a standalone copy of the dashboard's account, workspace, usage and billing tabs: 900
 * lines that drifted from the real ones (the infinite invite refetch of review H8 lived only here)
 * and that nothing in the app linked to any more. The URL stays, because view emails sent before
 * the dashboard existed point at `/preferences?tab=account#email-preferences`; the tab is mapped
 * and the browser carries the fragment across the redirect.
 */
import { redirect } from "next/navigation";

import { dashboardTabFor } from "./tabs";

export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  const raw = Array.isArray(tab) ? tab[0] : tab;
  redirect(`/dashboard?tab=${encodeURIComponent(dashboardTabFor(raw))}`);
}
