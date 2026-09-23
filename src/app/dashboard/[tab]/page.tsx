/**
 * Page for `/dashboard/:tab` — pretty URL wrapper around `/dashboard?tab=...`.
 */
import { redirect } from "next/navigation";
import { FEATURE_CREDITS_ENABLED } from "@/lib/client/planLimit";

// Keep legacy `spending` for backwards compatibility (redirects to `limits`).
const ALLOWED = new Set(["overview", "account", "workspace", "teams", "usage", "limits", "spending", "billing"]);

// Credits surfaces (AI Credits usage + on-demand limits) ship on: `FEATURE_CREDITS_ENABLED` is
// `NEXT_PUBLIC_FEATURE_CREDITS !== "0"`, so these tabs fall back to Overview only at an explicit 0.
const CREDITS_TABS = new Set(["usage", "limits"]);

/**
 * Redirect `/dashboard/:tab` to `/dashboard?tab=...`; credits tabs fall back to Overview when the flag is explicitly off.
 */
export default async function DashboardTabPage({
  params,
}: {
  params: Promise<{ tab?: string }>;
}) {
  const { tab } = await params;
  const next = typeof tab === "string" ? tab : "";
  const normalized = next === "spending" ? "limits" : next;
  const resolved = ALLOWED.has(normalized) ? normalized : "account";
  const target = !FEATURE_CREDITS_ENABLED && CREDITS_TABS.has(resolved) ? "overview" : resolved;
  redirect(`/dashboard?tab=${encodeURIComponent(target)}`);
}


