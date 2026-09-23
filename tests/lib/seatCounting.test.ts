/**
 * A seat is someone who can change something. Reading is free.
 *
 * `getWorkspaceUsage` counted every `OrgMembership` row, whatever its role, so inviting a colleague
 * to *look* at the analytics consumed the same seat as the co-founder who uploads. With Pro
 * including one collaborator, that meant a workspace owner and one other person, and the third got
 * "Contact us to add more seats to this workspace" — an email to ask permission to use something
 * they had already paid for.
 *
 * Pro now includes three, and a `viewer` costs nothing. That only holds while `viewer` really is
 * read-only, so the second test pins the thing the pricing rests on: every route that writes is
 * gated above `viewer`. If someone ever lowers a mutating route to `minRole: "viewer"`, free
 * viewers stop being free to give away, and this fails rather than quietly becoming a giveaway of
 * write access.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** The file with comments removed: these assertions are about code, not about prose describing it. */
function codeOf(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("what counts as a seat", () => {
  test("the usage query excludes viewers", () => {
    const code = codeOf("src/lib/billing/planLimits.ts");
    const call = code.slice(code.indexOf("OrgMembershipModel.countDocuments("));

    expect(call.slice(0, 160)).toContain('role: { $ne: "viewer" }');
  });

  test("Pro includes more than one person, and the refusal does not ask them to send an email", async () => {
    const code = codeOf("src/lib/billing/planLimits.ts");
    const { PRO_INCLUDED_COLLABORATORS } = await import("@/lib/billing/planLimits");

    expect(PRO_INCLUDED_COLLABORATORS).toBeGreaterThan(1);
    // The old refusal sent a paying customer to email us for a seat. It must not come back.
    expect(code).not.toContain("Contact us to add more seats");
  });
});

describe("viewers are read-only, which is what makes them free", () => {
  /** Every `route.ts` under src/app/api, with its source. */
  function apiRoutes(dir: string): Array<{ path: string; src: string }> {
    const out: Array<{ path: string; src: string }> = [];
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...apiRoutes(rel));
      else if (e.name === "route.ts") out.push({ path: rel, src: readFileSync(join(ROOT, rel), "utf8") });
    }
    return out;
  }

  test("no route gated at viewer also exports a mutating handler", () => {
    const offenders: string[] = [];
    for (const { path, src } of apiRoutes("src/app/api")) {
      if (!/minRole:\s*"viewer"/.test(src)) continue;
      const writes = ["POST", "PATCH", "PUT", "DELETE"].filter((m) =>
        new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(src),
      );
      // A route may gate a GET at viewer and its POST higher; only flag a file whose *only*
      // gate is viewer while it still exports a writer.
      if (writes.length && !/minRole:\s*"(member|admin|owner)"/.test(src)) {
        offenders.push(`${path} (${writes.join(", ")})`);
      }
    }
    expect(offenders, "routes a free viewer could write through").toEqual([]);
  });
});
