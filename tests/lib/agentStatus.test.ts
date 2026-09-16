import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const apiKeyFind = vi.fn();
const apiKeyCountDocuments = vi.fn(async () => 0);
const userFind = vi.fn(() => ({ select: () => ({ lean: async () => [] }) }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/ApiKey", () => ({
  API_KEY_SCOPES: ["read", "write"],
  ApiKeyModel: { find: apiKeyFind, countDocuments: apiKeyCountDocuments },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: userFind } }));

const { getAgentStatus, API_KEY_LIST_LIMIT } = await import("@/lib/agents/apiKeys");

const ORG = new Types.ObjectId();

type Doc = { _id: Types.ObjectId; name: string; prefix: string; scopes: string[]; createdDate: Date; lastUsedAt: Date | null; lastUsedClient: string | null; revokedAt: Date | null };

function doc(over: Partial<Doc> = {}): Doc {
  return {
    _id: new Types.ObjectId(),
    name: "key",
    prefix: "lnk_abcdefgh",
    scopes: ["read", "write"],
    createdDate: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    lastUsedClient: null,
    revokedAt: null,
    ...over,
  };
}

/** Serve `ApiKeyModel.find(filter).sort().limit().select().lean()` from a filter-aware responder. */
function serve(respond: (filter: Record<string, unknown>) => Doc[]) {
  apiKeyFind.mockImplementation((filter: Record<string, unknown>) => {
    let limit = Infinity;
    const chain = {
      sort: () => chain,
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      select: () => chain,
      lean: async () => respond(filter).slice(0, limit),
    };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiKeyCountDocuments.mockResolvedValue(0);
  userFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

describe("getAgentStatus", () => {
  test("an in-use key past the management list's cap still reports connected", async () => {
    const inUse = doc({ name: "Claude Code on my laptop", lastUsedAt: new Date("2026-09-16T19:56:52.258Z"), lastUsedClient: "Claude Code" });
    // The management list is newest-created first, so a churn of newer keys buries the in-use one.
    const newer = Array.from({ length: API_KEY_LIST_LIMIT + 5 }, (_, i) =>
      doc({ name: `e2e ${i}`, createdDate: new Date("2026-09-17T00:00:00.000Z"), revokedAt: new Date() }),
    );
    serve((filter) => ("lastUsedAt" in filter ? [inUse] : [...newer, inUse]));
    apiKeyCountDocuments.mockResolvedValue(1);

    const status = await getAgentStatus(ORG);

    expect(status.connected).toBe(true);
    expect(status.lastUsedClient).toBe("Claude Code");
    expect(status.clients.map((c) => c.client)).toEqual(["Claude Code"]);
    expect(status.keys).toHaveLength(API_KEY_LIST_LIMIT);
  });

  test("activeKeys counts the whole workspace, not just the capped page", async () => {
    serve(() => []);
    apiKeyCountDocuments.mockResolvedValue(3);

    expect((await getAgentStatus(ORG)).activeKeys).toBe(3);
  });

  test("a key last used by an HTTP tool is verified but not connected", async () => {
    serve((filter) => ("lastUsedAt" in filter ? [doc({ lastUsedAt: new Date("2026-09-16T19:40:31.259Z"), lastUsedClient: "API key" })] : []));

    const status = await getAgentStatus(ORG);

    expect(status.connected).toBe(false);
    expect(status.verified).toBe(true);
    expect(status.lastVerified?.client).toBe("API key");
  });

  test("with no used keys the workspace is neither connected nor verified", async () => {
    serve(() => []);

    const status = await getAgentStatus(ORG);

    expect(status).toMatchObject({ connected: false, verified: false, connectedCount: 0 });
  });
});
