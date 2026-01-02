/**
 * Page for `/dashboard/:tab` — pretty URL wrapper around `/dashboard?tab=...`.
 */
import { redirect } from "next/navigation";

const ALLOWED = new Set(["account", "workspace", "usage", "spending", "billing"]);

export default async function DashboardTabPage({
  params,
}: {
  params: Promise<{ tab?: string }>;
}) {
  const { tab } = await params;
  const next = typeof tab === "string" ? tab : "";
  redirect(`/dashboard?tab=${encodeURIComponent(ALLOWED.has(next) ? next : "account")}`);
}


