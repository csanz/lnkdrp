/**
 * Page for `/dashboard/account` — account settings and actions.
 *
 * Redirects to `/dashboard?tab=account` so the existing dashboard shell (left nav) is preserved.
 */
import { redirect } from "next/navigation";

export default function DashboardAccountPage() {
  redirect("/dashboard?tab=account");
}


