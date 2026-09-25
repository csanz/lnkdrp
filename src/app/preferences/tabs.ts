/**
 * Where each old `/preferences` tab lives on the dashboard.
 *
 * `/preferences` was a standalone copy of the dashboard's account, workspace, usage and billing
 * tabs that nothing linked to any more; both of its routes now redirect here. Kept out of the page
 * files because a page module may only export what Next.js expects of a page.
 */
const TAB_TO_DASHBOARD: Record<string, string> = {
  account: "account",
  workspace: "workspace",
  usage: "usage",
  spending: "billing",
  billing: "billing",
};

/** The dashboard tab for an old preferences tab; unknown or missing tabs go to Account. */
export function dashboardTabFor(tab: string | undefined): string {
  return TAB_TO_DASHBOARD[(tab ?? "").trim()] ?? "account";
}
