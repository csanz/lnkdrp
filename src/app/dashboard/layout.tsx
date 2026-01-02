/**
 * Layout for `/dashboard/*` — standalone dashboard shell (no app sidebar).
 */
import DashboardShell from "./dashboardShell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}


