import { describe, expect, test } from "vitest";

import { stableSortOrgs } from "@/lib/orgs/orgsClient";
import { initialsFromNameOrEmail } from "@/lib/format/initials";

describe("format/initials", () => {
  test("derives initials from names and emails", () => {
    expect(initialsFromNameOrEmail("")).toBe("?");
    expect(initialsFromNameOrEmail("   ")).toBe("?");
    expect(initialsFromNameOrEmail("Ada")).toBe("AD");
    expect(initialsFromNameOrEmail("Ada Lovelace")).toBe("AL");
    expect(initialsFromNameOrEmail("  Ada   Lovelace ")).toBe("AL");
    expect(initialsFromNameOrEmail("a@b.com")).toBe("A@");
  });
});

describe("orgs/orgsClient.stableSortOrgs", () => {
  test("sorts personal first, then by name, then by id", () => {
    const rows = stableSortOrgs([
      { id: "3", name: "Zeta", type: "org", role: "member" },
      { id: "2", name: "Acme", type: "org", role: "member" },
      { id: "1", name: "Personal Space", type: "personal", role: "owner" },
      { id: "4", name: "Acme", type: "org", role: "member" },
    ]);

    expect(rows.map((r) => r.id)).toEqual(["1", "2", "4", "3"]);
  });
});

