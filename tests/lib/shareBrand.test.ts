/**
 * Naming the sender on a recipient-facing page (`src/lib/share/shareBrand.ts`).
 *
 * The rule worth pinning is the personal workspace. Every user has one and it is called "Personal"
 * (`ensurePersonalOrgForUserId`) — a label for its owner's own sidebar, and meaningless as a
 * signature on a document sent to someone else. "Shared by Personal" in a header, or on a password
 * gate, is worse than no name at all, so a personal workspace is named after the person and named
 * nothing at all when that cannot be resolved.
 *
 * The split between this module and `./brand` is also load-bearing and is asserted below: this one
 * reaches Mongo, and `BrandHeader` renders the shape inside the client bundle. When the two lived
 * together, one value import took every page in the app down at module evaluation.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { orgFindOne, userFindById } = vi.hoisted(() => ({
  orgFindOne: vi.fn(),
  userFindById: vi.fn(),
}));

vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/models/User", () => ({ UserModel: { findById: userFindById } }));

import { brandInitials, workspaceBrandForOrg } from "@/lib/share/shareBrand";

const ORG_ID = new Types.ObjectId();
const OWNER_ID = new Types.ObjectId();

/** `OrgModel.findOne(...).select(...).lean()` */
function org(doc: Record<string, unknown> | null) {
  orgFindOne.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}
/** `UserModel.findById(...).select(...).lean()` */
function user(doc: Record<string, unknown> | null) {
  userFindById.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  user(null);
});

describe("workspaceBrandForOrg", () => {
  test("a team workspace signs with its own name and icon", async () => {
    org({ name: "USAVX", avatarUrl: " https://cdn/logo.png ", type: "team" });
    expect(await workspaceBrandForOrg(ORG_ID)).toEqual({ name: "USAVX", avatarUrl: "https://cdn/logo.png" });
  });

  test("a first workspace that was named signs with that name, like any other", async () => {
    org({ name: "LNKDRP", avatarUrl: null, type: "personal", personalForUserId: OWNER_ID });
    user({ name: "Christian Sanz", email: "c@usavx.com" });
    expect(await workspaceBrandForOrg(ORG_ID)).toEqual({ name: "LNKDRP", avatarUrl: null });
  });

  test("a workspace still called “Personal” signs with the person, never that word", async () => {
    org({ name: "Personal", avatarUrl: null, type: "personal", personalForUserId: OWNER_ID });
    user({ name: "Christian Sanz", email: "c@usavx.com" });
    expect(await workspaceBrandForOrg(ORG_ID)).toEqual({ name: "Christian Sanz", avatarUrl: null });
  });

  test("a personal workspace whose owner has no name falls back to the local part of their address", async () => {
    org({ name: "Personal", avatarUrl: null, type: "personal", personalForUserId: OWNER_ID });
    // The domain is not ours to put in someone else's header.
    user({ name: "  ", email: "c@usavx.com" });
    expect(await workspaceBrandForOrg(ORG_ID)).toEqual({ name: "c", avatarUrl: null });
  });

  test("an unnameable workspace is unsigned rather than wrongly signed", async () => {
    org({ name: "Personal", avatarUrl: null, type: "personal", personalForUserId: OWNER_ID });
    user({ name: null, email: null });
    expect(await workspaceBrandForOrg(ORG_ID)).toBeNull();

    org({ name: "   ", avatarUrl: null, type: "team" });
    expect(await workspaceBrandForOrg(ORG_ID)).toBeNull();

    org(null);
    expect(await workspaceBrandForOrg(ORG_ID)).toBeNull();
  });

  test("never throws: a header that cannot name the sender must not fail the page", async () => {
    expect(await workspaceBrandForOrg(null)).toBeNull();
    expect(await workspaceBrandForOrg("not-an-id")).toBeNull();
    orgFindOne.mockImplementation(() => {
      throw new Error("mongo is having a moment");
    });
    expect(await workspaceBrandForOrg(ORG_ID)).toBeNull();
  });
});

describe("brandInitials", () => {
  test("first and last initial, one for a single word", () => {
    expect(brandInitials("USAVX Holdings")).toBe("UH");
    expect(brandInitials("Christian")).toBe("C");
    expect(brandInitials("  jane  q  doe ")).toBe("JD");
    expect(brandInitials("   ")).toBe("");
  });

  test("is importable without pulling a database driver into the bundle", async () => {
    // `BrandHeader` renders a brand inside the client bundle, so this module must stay import-free.
    // A value import that crossed into `shareBrand.ts` put mongoose in the browser and threw at
    // module evaluation on every page in the app.
    const leaf = await import("@/lib/share/brand");
    expect(typeof leaf.brandInitials).toBe("function");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/lib/share/brand.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
