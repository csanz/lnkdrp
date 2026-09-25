/**
 * `/preferences/:tab` redirects to the dashboard tab it used to be a pretty URL for.
 */
import { redirect } from "next/navigation";

import { dashboardTabFor } from "../tabs";

export default async function PreferencesTabPage({
  params,
}: {
  params: Promise<{ tab?: string }>;
}) {
  const { tab } = await params;
  redirect(`/dashboard?tab=${encodeURIComponent(dashboardTabFor(tab))}`);
}
