/**
 * Page for `/preferences/:tab` — pretty URL wrapper around `/preferences?tab=...`.
 */
import { redirect } from "next/navigation";

const ALLOWED = new Set(["account", "workspace", "usage", "spending", "billing"]);

export default async function PreferencesTabPage({
  params,
}: {
  params: Promise<{ tab?: string }>;
}) {
  const { tab } = await params;
  const next = typeof tab === "string" ? tab : "";
  redirect(`/preferences?tab=${encodeURIComponent(ALLOWED.has(next) ? next : "account")}`);
}


