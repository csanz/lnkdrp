import { initialsFromNameOrEmail } from "@/lib/format/initials";

export type OrgRow = { id: string; name: string; type: string; role: string; avatarUrl?: string | null };

/**
 * Ensure stable workspace ordering across UIs:
 * - Personal workspace first
 * - Then by name (localeCompare)
 * - Then by id as a tie-breaker
 */
export function stableSortOrgs(orgs: OrgRow[]): OrgRow[] {
  const rows = Array.isArray(orgs) ? [...orgs] : [];
  rows.sort((a, b) => {
    const aPersonal = a.type === "personal";
    const bPersonal = b.type === "personal";
    if (aPersonal && !bPersonal) return -1;
    if (bPersonal && !aPersonal) return 1;
    const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
    if (byName) return byName;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
  return rows;
}

/**
 * Convenience re-export for callers that keep the "initials" naming.
 */
export function initials(nameOrEmail: string): string {
  return initialsFromNameOrEmail(nameOrEmail);
}

