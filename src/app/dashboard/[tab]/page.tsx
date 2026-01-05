/**
 * Page for `/dashboard/:tab` — pretty URL wrapper around `/dashboard?tab=...`.
 */
import { redirect } from "next/navigation";

// Keep legacy `spending` for backwards compatibility (redirects to `limits`).
const ALLOWED = new Set(["overview", "account", "workspace", "teams", "usage", "limits", "spending", "billing"]);

export default async function DashboardTabPage({
  params,
}: {
  params: Promise<{ tab?: string }>;
}) {
  const { tab } = await params;
  const next = typeof tab === "string" ? tab : "";
  const normalized = next === "spending" ? "limits" : next;
  redirect(`/dashboard?tab=${encodeURIComponent(ALLOWED.has(normalized) ? normalized : "account")}`);
}


