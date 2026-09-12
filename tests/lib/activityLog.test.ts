import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const activityCreate = vi.fn();
const connectMongo = vi.fn(async () => undefined);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { create: activityCreate } }));

const { agentFromRequest, agentLabel, recordActivity, ACTIVITY_AGENT_HEADER } = await import("@/lib/activity/log");

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/test", { headers });
}

describe("activity/log.agentFromRequest", () => {
  test("parses `<client>/<version>` from the x-lnkdrp-agent header", () => {
    expect(agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: "claude-code/1.2.3" }))).toEqual({
      client: "claude-code",
      version: "1.2.3",
    });
  });

  test("parses `<client>` without a version", () => {
    expect(agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: "cursor" }))).toEqual({ client: "cursor", version: null });
  });

  test("lowercases, trims and length-caps the client id", () => {
    expect(agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: "  Claude-Desktop / 0.9 " }))).toEqual({
      client: "claude-desktop",
      version: "0.9",
    });
    const long = "a".repeat(100);
    const parsed = agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: `${long}/1` }));
    expect(parsed?.client).toBe("a".repeat(64));
  });

  test("header takes precedence over the user-agent", () => {
    expect(
      agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: "codex/2", "user-agent": "claude-code/9.9" })),
    ).toEqual({ client: "codex", version: "2" });
  });

  test("falls back to user-agent sniffing when the header is invalid", () => {
    expect(agentFromRequest(req({ [ACTIVITY_AGENT_HEADER]: "not valid!", "user-agent": "codex-cli/0.1" }))).toEqual({
      client: "codex",
      version: null,
    });
  });

  test("sniffs known agent clients from the user-agent", () => {
    expect(agentFromRequest(req({ "user-agent": "claude-code/1.0.0 (darwin)" }))).toEqual({
      client: "claude-code",
      version: null,
    });
    expect(agentFromRequest(req({ "user-agent": "Cursor/0.45 Electron" }))).toEqual({ client: "cursor", version: null });
    expect(agentFromRequest(req({ "user-agent": "codex 1.0" }))).toEqual({ client: "codex", version: null });
    expect(agentFromRequest(req({ "user-agent": "gemini-cli/0.3" }))).toEqual({ client: "gemini-cli", version: null });
  });

  test("returns null for ordinary browsers and missing requests", () => {
    expect(
      agentFromRequest(
        req({
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        }),
      ),
    ).toBeNull();
    expect(agentFromRequest(req({}))).toBeNull();
    expect(agentFromRequest(null)).toBeNull();
    expect(agentFromRequest(undefined)).toBeNull();
  });
});

describe("activity/log.agentLabel", () => {
  test("maps well-known client ids", () => {
    expect(agentLabel({ client: "claude-code", version: null })).toBe("Claude Code");
    expect(agentLabel({ client: "claude-desktop", version: "1" })).toBe("Claude Desktop");
    expect(agentLabel({ client: "cursor", version: null })).toBe("Cursor");
    expect(agentLabel({ client: "codex", version: null })).toBe("Codex");
    expect(agentLabel({ client: "gemini-cli", version: null })).toBe("Gemini CLI");
    expect(agentLabel({ client: "grok", version: null })).toBe("Grok");
  });

  test("title-cases unknown client ids and returns null for null", () => {
    expect(agentLabel({ client: "my-custom_tool", version: null })).toBe("My Custom Tool");
    expect(agentLabel(null)).toBeNull();
  });
});

describe("activity/log.recordActivity", () => {
  beforeEach(() => {
    activityCreate.mockReset();
    connectMongo.mockClear();
  });

  test("inserts a row with agent + ip derived from the request", async () => {
    const orgId = new Types.ObjectId();
    const userId = new Types.ObjectId().toString();
    const docId = new Types.ObjectId();
    activityCreate.mockResolvedValue({});

    await recordActivity({
      orgId,
      userId,
      actorKind: "user",
      type: "doc.created",
      docId,
      title: "  Series A Memo  ",
      meta: { source: "test" },
      request: req({ [ACTIVITY_AGENT_HEADER]: "claude-code/1.0", "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    });

    expect(connectMongo).toHaveBeenCalledTimes(1);
    expect(activityCreate).toHaveBeenCalledTimes(1);
    const row = activityCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.orgId).toEqual(orgId);
    expect(row.userId).toEqual(new Types.ObjectId(userId));
    expect(row.actorKind).toBe("user");
    expect(row.agent).toEqual({ client: "claude-code", version: "1.0" });
    expect(row.type).toBe("doc.created");
    expect(row.docId).toEqual(docId);
    expect(row.projectId).toBeNull();
    expect(row.uploadId).toBeNull();
    expect(row.title).toBe("Series A Memo");
    expect(row.meta).toEqual({ source: "test" });
    expect(row.ip).toBe("203.0.113.9");
    expect(row.createdDate).toBeInstanceOf(Date);
  });

  test("explicit agent (including null) overrides request sniffing", async () => {
    activityCreate.mockResolvedValue({});
    await recordActivity({
      orgId: new Types.ObjectId(),
      actorKind: "secret",
      agent: null,
      type: "doc.replaced",
      request: req({ "user-agent": "claude-code/1" }),
    });
    const row = activityCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.agent).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.ip).toBeNull();
  });

  test("never throws: invalid orgId is skipped and insert failures are swallowed", async () => {
    await expect(
      recordActivity({ orgId: "nope", actorKind: "user", type: "doc.deleted" }),
    ).resolves.toBeUndefined();
    expect(activityCreate).not.toHaveBeenCalled();

    activityCreate.mockRejectedValue(new Error("boom"));
    await expect(
      recordActivity({ orgId: new Types.ObjectId(), actorKind: "user", type: "doc.deleted" }),
    ).resolves.toBeUndefined();
  });
});
