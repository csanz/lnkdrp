import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Two regressions in the Teams -> Invites panel, pinned against the component source because
 * TeamsManager is a client component with no render harness in this suite (the same source-text
 * approach tests/lib/viewNotificationsLegalCopy.test.ts uses for page copy).
 *
 * 1. `POST /api/org-invites/revoke` shipped with no caller anywhere in the app: the Invites table
 *    was read-only, so an invite sent to the wrong address stayed claimable for its full 14-day
 *    TTL. If this file stops naming the route, the endpoint is orphaned again.
 *
 * 2. The invite controls were gated on `plan?.plan === "free"`, which is `false` while `usePlan()`
 *    is still `null` — so during the first load a Free workspace got enabled Generate-link and
 *    Send-invite buttons and a raw plan-limit error on click. The disabled props must key off a
 *    gate that also blocks while the plan is unknown.
 */
const SOURCE = readFileSync(
  path.resolve(__dirname, "../../src/app/dashboard/TeamsManager.tsx"),
  "utf8",
);
/** Whitespace collapsed, so wrapped JSX still matches on one line. */
const FLAT = SOURCE.replace(/\s+/g, " ");

describe("Teams invite controls", () => {
  test("an unused invite row can be revoked through /api/org-invites/revoke", () => {
    expect(FLAT).toContain('fetchJson("/api/org-invites/revoke"');
    expect(FLAT).toContain('body: JSON.stringify({ inviteId, orgId: activeOrgId })');
    // The route refuses a redeemed invite, so the button is only offered on unused rows.
    expect(FLAT).toMatch(/status === "Not used" && inv\.id \?/);
    // …and the list is refetched afterwards, or the revoked row lingers on screen.
    expect(FLAT).toMatch(/setRevokingInvite\(null\);.*loadExistingInvites\(\{ force: true \}\)/);
  });

  test("an unresolved plan blocks the invite controls rather than permitting them", () => {
    expect(FLAT).toContain("const planUnresolved = plan === null;");
    expect(FLAT).toContain("const inviteControlsBlocked = planUnresolved || inviteBlockedByPlan;");
    // No disabled/aria-disabled prop may still be keyed on the plan-only flag.
    expect(FLAT).not.toMatch(/(?:aria-)?disabled=\{[^}]*inviteBlockedByPlan/);
    // The guards inside createInvite/sendInviteEmail moved too, so a keyboard submit is blocked.
    expect(FLAT.match(/if \(inviteControlsBlocked\) return;/g) ?? []).toHaveLength(2);
  });

  test("the Free upsell notice still keys off the resolved plan, so Pro never flashes it", () => {
    expect(FLAT).toContain("const inviteBlockedByPlan = plan?.plan === \"free\";");
    expect(FLAT).toContain("{canInvite && inviteBlockedByPlan ? (");
  });
});
