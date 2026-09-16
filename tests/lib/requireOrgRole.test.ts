import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const membershipFindOne = vi.fn();
const orgExists = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne: membershipFindOne } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { exists: orgExists } }));

const { requireOrgRole, roleAtLeast, isOrgRole } = await import("@/lib/orgs/requireOrgRole");

const ORG = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();

function membership(role: string | null) {
  membershipFindOne.mockReturnValue({
    select: () => ({ lean: async () => (role ? { role } : null) }),
  });
}

describe("orgs/requireOrgRole.roleAtLeast", () => {
  test("orders owner > admin > member > viewer", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(isOrgRole("owner")).toBe(true);
    expect(isOrgRole("superuser")).toBe(false);
  });
});

describe("link permissions derived from a role (mt_j7nN3wG65Q)", () => {
  // What GET /api/plan puts in the snapshot, and what DocLinksManager gates its controls on.
  // Editing a link takes `member`; reading its password back takes `admin`. Both call sites used
  // to pass nothing and the component defaulted to "can manage", so every viewer saw New link,
  // Edit and the Password pill and found out otherwise from a 403.
  const canManageLinks = (role: Parameters<typeof roleAtLeast>[0]) => roleAtLeast(role, "member");
  const canRevealPassword = (role: Parameters<typeof roleAtLeast>[0]) => roleAtLeast(role, "admin");

  test("a viewer may do neither", () => {
    expect(canManageLinks("viewer")).toBe(false);
    expect(canRevealPassword("viewer")).toBe(false);
  });

  test("a member may edit a link but not read its password", () => {
    expect(canManageLinks("member")).toBe(true);
    expect(canRevealPassword("member")).toBe(false);
  });

  test("admins and owners may do both", () => {
    for (const role of ["admin", "owner"] as const) {
      expect(canManageLinks(role)).toBe(true);
      expect(canRevealPassword(role)).toBe(true);
    }
  });
});

describe("orgs/requireOrgRole.requireOrgRole", () => {
  beforeEach(() => {
    membershipFindOne.mockReset();
    orgExists.mockReset();
    orgExists.mockResolvedValue(null);
  });

  test("passes members/admins/owners for minRole=member and rejects viewers", async () => {
    membership("member");
    expect(await requireOrgRole({ orgId: ORG, userId: USER, minRole: "member" })).toEqual({ ok: true, role: "member" });
    membership("owner");
    expect(await requireOrgRole({ orgId: ORG, userId: USER, minRole: "member" })).toEqual({ ok: true, role: "owner" });
    membership("viewer");
    expect(await requireOrgRole({ orgId: ORG, userId: USER, minRole: "member" })).toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
  });

  test("rejects missing membership unless the org is the caller's personal org", async () => {
    membership(null);
    expect((await requireOrgRole({ orgId: ORG, userId: USER, minRole: "member" })).ok).toBe(false);

    orgExists.mockResolvedValue({ _id: ORG });
    expect(await requireOrgRole({ orgId: ORG, userId: USER, minRole: "member" })).toEqual({ ok: true, role: "owner" });
    expect(orgExists).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "personal", personalForUserId: new Types.ObjectId(USER) }),
    );
  });

  test("rejects invalid ids without touching the database", async () => {
    expect(await requireOrgRole({ orgId: "nope", userId: USER, minRole: "viewer" })).toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
    expect(membershipFindOne).not.toHaveBeenCalled();
  });
});
