/**
 * The admin gate (`src/lib/gating/requireAdmin.ts`).
 *
 * The case that matters is the last one: an API key belonging to an admin must not open the admin
 * endpoints. Keys resolve to the member who created them, so before this gate existed an admin who
 * connected an agent to share a PDF had handed it every user's record, the error log, billing and
 * cron health — none of which any key scope mentions. It had also been copy-pasted into twenty-six
 * route files in four drifting versions, which is why it is one module with a test now.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const resolveActor = vi.fn();
const userFindOne = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor }));
vi.mock("@/lib/models/User", () => ({ UserModel: { findOne: userFindOne } }));

const { requireAdmin } = await import("@/lib/gating/requireAdmin");

const USER = new Types.ObjectId().toString();
const ORG = new Types.ObjectId().toString();

/** A request that cannot take the development localhost bypass. */
function req(): Request {
  return new Request("https://lnkdrp.com/api/admin/data/users", { headers: { host: "lnkdrp.com" } });
}

function role(value: string | null): void {
  userFindOne.mockReturnValue({ select: () => ({ lean: async () => (value ? { role: value, email: "a@b.test" } : null) }) });
}

function sessionActor(): void {
  resolveActor.mockResolvedValue({ kind: "user", userId: USER, orgId: ORG, personalOrgId: ORG });
}

function apiKeyActor(): void {
  resolveActor.mockResolvedValue({
    kind: "user",
    userId: USER,
    orgId: ORG,
    personalOrgId: ORG,
    viaApiKey: { keyId: new Types.ObjectId().toString(), scopes: ["read", "write"] },
  });
}

describe("gating/requireAdmin", () => {
  beforeEach(() => {
    resolveActor.mockReset();
    userFindOne.mockReset();
    vi.stubEnv("NODE_ENV", "production");
  });

  test("lets a signed-in admin through, with their identity", async () => {
    sessionActor();
    role("admin");
    const gate = await requireAdmin(req());
    expect(gate).toEqual({ ok: true, userId: USER, email: "a@b.test" });
  });

  test("refuses a signed-in non-admin", async () => {
    sessionActor();
    role("user");
    expect(await requireAdmin(req())).toEqual({ ok: false, status: 403, error: "Forbidden" });
  });

  test("refuses an anonymous request", async () => {
    resolveActor.mockResolvedValue({ kind: "temp", userId: USER, orgId: ORG, personalOrgId: ORG, temp: { id: "t" }, isNew: true });
    expect(await requireAdmin(req())).toEqual({ ok: false, status: 401, error: "Not authenticated" });
  });

  test("refuses an API key even when its owner is an admin", async () => {
    apiKeyActor();
    role("admin");
    const gate = await requireAdmin(req());
    expect(gate).toEqual({ ok: false, status: 403, error: "API keys cannot access admin endpoints" });
  });

  test("decides on the key before the role, so the two refusals are indistinguishable", async () => {
    // A different reply for an admin's key than for anyone else's would confirm to the holder of a
    // stolen key that its owner is an administrator.
    apiKeyActor();
    role("user");
    const nonAdminKey = await requireAdmin(req());
    apiKeyActor();
    role("admin");
    const adminKey = await requireAdmin(req());
    expect(nonAdminKey).toEqual(adminKey);
    // And the role was never looked up on either path.
    expect(userFindOne).not.toHaveBeenCalled();
  });

  test("the localhost bypass is development-only and can be switched off", async () => {
    const local = () => new Request("http://localhost:3001/api/admin/data/users", { headers: { host: "localhost:3001" } });
    vi.stubEnv("NODE_ENV", "production");
    resolveActor.mockResolvedValue({ kind: "temp", userId: USER, orgId: ORG, personalOrgId: ORG, temp: { id: "t" }, isNew: true });
    expect(await requireAdmin(local())).toEqual({ ok: false, status: 401, error: "Not authenticated" });

    vi.stubEnv("NODE_ENV", "development");
    expect(await requireAdmin(local())).toEqual({ ok: true, userId: null, email: null });

    vi.stubEnv("ADMIN_LOCALHOST_BYPASS", "0");
    expect(await requireAdmin(local())).toEqual({ ok: false, status: 401, error: "Not authenticated" });
    vi.unstubAllEnvs();
  });
});
