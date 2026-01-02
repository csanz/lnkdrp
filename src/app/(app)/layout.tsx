/**
 * Layout for the authenticated app shell routes under `src/app/(app)/*`.
 */
import AppShellLayout from "./AppShellLayout";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShellLayout>{children}</AppShellLayout>;
}



