/**
 * Layout for `/preferences/*` — standalone preferences shell (no app sidebar).
 */
import PreferencesShell from "./preferencesShell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <PreferencesShell>{children}</PreferencesShell>;
}


