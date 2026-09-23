/**
 * Plain customer cards: the door and the shape.
 *
 * The door: the route hands out a customer's plan, credits, usage and error log to whoever can
 * call it, so it must refuse an unsigned body, a body signed with the wrong secret, and — the
 * one that matters most on a fresh deploy — every request when no secret is configured at all.
 *
 * The shape: Plain renders exactly what we return and requires a card for every key it asked
 * for. The builders are checked against Plain's component vocabulary so a typo in a colour or a
 * size fails here, not silently in the Plain sidebar.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import { buildAccountCard, buildCards, buildErrorsCard, type CustomerContext } from "@/lib/support/plain/cards";
import { signPlainBody, verifyPlainSignature } from "@/lib/support/plain/signature";

const { loadCustomerContext } = vi.hoisted(() => ({ loadCustomerContext: vi.fn<(email: string) => Promise<CustomerContext>>() }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/support/plain/cards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/support/plain/cards")>();
  return { ...actual, loadCustomerContext };
});

const { POST } = await import("@/app/api/support/plain/customer-cards/route");

const SECRET = "test-signing-secret";

const FOUND: CustomerContext = {
  found: true,
  email: "ada@example.com",
  userId: "64b000000000000000000001",
  name: "Ada",
  role: "user",
  createdAt: "2026-08-01T10:00:00.000Z",
  lastLoginAt: "2026-09-22T08:00:00.000Z",
  deletionRequestedAt: null,
  workspaces: [
    {
      id: "64b000000000000000000010",
      name: "Personal",
      type: "personal",
      role: "owner",
      plan: "free",
      grace: { startedAt: "2026-09-10T00:00:00.000Z", endsAt: "2026-09-24T00:00:00.000Z", blockedAt: null },
      creditsRemaining: 0,
      onDemandEnabled: false,
      usage: { documents: 12, projects: 1, members: 1 },
      limits: { documents: 10, projects: 2 },
      agent: { connected: true, clients: ["Claude Code"], lastUsedAt: "2026-09-22T09:00:00.000Z" },
    },
    {
      id: "64b000000000000000000011",
      name: "Acme",
      type: "team",
      role: "member",
      plan: "pro",
      grace: null,
      creditsRemaining: 340,
      onDemandEnabled: true,
      usage: { documents: 40, projects: 6, members: 4 },
      limits: { documents: null, projects: null },
      agent: { connected: false, clients: [], lastUsedAt: null },
    },
  ],
  errors: [
    { at: "2026-09-21T14:03:00.000Z", code: "PDF_RENDER_FAILED", route: "/api/uploads", statusCode: 500, message: "sharp: input buffer is empty", workspaceName: "Personal" },
  ],
};

/** A request signed the way Plain signs: hex HMAC-SHA256 of the raw body. */
function signed(body: unknown, secret = SECRET, headerOverride?: string | null) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = headerOverride === undefined ? signPlainBody(raw, secret) : headerOverride;
  if (sig !== null) headers["plain-request-signature"] = sig;
  return new Request("http://localhost/api/support/plain/customer-cards", { method: "POST", headers, body: raw });
}

const REQUEST = { cardKeys: ["lnkdrp-account", "lnkdrp-errors"], customer: { id: "c_1", email: "ada@example.com", externalId: null } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLAIN_REQUEST_SIGNING_SECRET = SECRET;
  loadCustomerContext.mockResolvedValue(FOUND);
});

describe("signature", () => {
  test("verifies Plain's hex HMAC-SHA256 over the raw body, case-insensitively", () => {
    const raw = '{"a":1}';
    const sig = signPlainBody(raw, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPlainSignature(raw, sig, SECRET)).toBe(true);
    expect(verifyPlainSignature(raw, sig.toUpperCase(), SECRET)).toBe(true);
    expect(verifyPlainSignature(raw, sig, "other")).toBe(false);
    expect(verifyPlainSignature('{"a":2}', sig, SECRET)).toBe(false);
    expect(verifyPlainSignature(raw, null, SECRET)).toBe(false);
    expect(verifyPlainSignature(raw, "", SECRET)).toBe(false);
  });
});

describe("POST /api/support/plain/customer-cards", () => {
  test("refuses everything when no secret is configured", async () => {
    process.env.PLAIN_REQUEST_SIGNING_SECRET = "";
    const res = await POST(signed(REQUEST));
    expect(res.status).toBe(503);
    expect(loadCustomerContext).not.toHaveBeenCalled();
  });

  test("refuses a missing or wrong signature before reading the customer", async () => {
    expect((await POST(signed(REQUEST, SECRET, null))).status).toBe(403);
    expect((await POST(signed(REQUEST, "wrong-secret"))).status).toBe(403);
    expect((await POST(signed(REQUEST, SECRET, "deadbeef"))).status).toBe(403);
    expect(loadCustomerContext).not.toHaveBeenCalled();
  });

  test("returns one card per requested key, unknown keys included", async () => {
    const res = await POST(signed({ ...REQUEST, cardKeys: ["lnkdrp-account", "mystery", "lnkdrp-errors"] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cards: { key: string; components: unknown }[] };
    expect(json.cards.map((c) => c.key)).toEqual(["lnkdrp-account", "mystery", "lnkdrp-errors"]);
    expect(json.cards[1]?.components).toBeNull();
    expect(Array.isArray(json.cards[0]?.components)).toBe(true);
    expect(loadCustomerContext).toHaveBeenCalledWith("ada@example.com");
  });

  test("answers a customer with no email without touching the database", async () => {
    const res = await POST(signed({ cardKeys: ["lnkdrp-account"], customer: { id: "c_2", email: null, externalId: null } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cards: { key: string; components: unknown[] }[] };
    expect(json.cards).toHaveLength(1);
    expect(JSON.stringify(json.cards[0])).toContain("No lnkdrp account");
    expect(loadCustomerContext).not.toHaveBeenCalled();
  });

  test("rejects a signed body that is not JSON", async () => {
    const raw = "not json";
    const req = new Request("http://localhost/api/support/plain/customer-cards", {
      method: "POST",
      headers: { "plain-request-signature": signPlainBody(raw, SECRET) },
      body: raw,
    });
    expect((await POST(req)).status).toBe(400);
  });
});

/** Every component must be one Plain knows, with enum values Plain accepts. */
const TEXT_COLORS = ["NORMAL", "MUTED", "SUCCESS", "WARNING", "ERROR"];
const TEXT_SIZES = ["S", "M", "L"];
const BADGE_COLORS = ["GREY", "GREEN", "YELLOW", "RED", "BLUE"];
const SPACES = ["XS", "S", "M", "L", "XL"];
const ROW_ALLOWED = ["componentBadge", "componentCopyButton", "componentDivider", "componentLinkButton", "componentSpacer", "componentText", "componentPlainText"];

/** Recursively checks one component against Plain's vocabulary. */
function assertComponent(c: Record<string, unknown>, inRow = false) {
  const keys = Object.keys(c);
  expect(keys).toHaveLength(1);
  const kind = keys[0] as string;
  if (inRow) expect(ROW_ALLOWED).toContain(kind);
  const v = c[kind] as Record<string, unknown>;
  switch (kind) {
    case "componentText":
      expect(typeof v.text).toBe("string");
      if (v.textColor !== undefined) expect(TEXT_COLORS).toContain(v.textColor);
      if (v.textSize !== undefined) expect(TEXT_SIZES).toContain(v.textSize);
      break;
    case "componentBadge":
      expect(typeof v.badgeLabel).toBe("string");
      expect(BADGE_COLORS).toContain(v.badgeColor);
      break;
    case "componentSpacer":
      expect(SPACES).toContain(v.spacerSize);
      break;
    case "componentDivider":
      if (v.dividerSpacingSize !== undefined) expect(SPACES).toContain(v.dividerSpacingSize);
      break;
    case "componentLinkButton":
      expect(typeof v.linkButtonLabel).toBe("string");
      expect(String(v.linkButtonUrl)).toMatch(/^https?:\/\//);
      break;
    case "componentCopyButton":
      expect(typeof v.copyButtonValue).toBe("string");
      break;
    case "componentRow": {
      const main = v.rowMainContent as Record<string, unknown>[];
      const aside = v.rowAsideContent as Record<string, unknown>[];
      expect(main.length).toBeGreaterThan(0);
      expect(aside.length).toBeGreaterThan(0);
      for (const x of [...main, ...aside]) assertComponent(x, true);
      break;
    }
    default:
      throw new Error(`unknown component ${kind}`);
  }
}

describe("card builders", () => {
  test("account card lists every workspace with plan, grace, credits, caps and agent state", () => {
    const card = buildAccountCard(FOUND);
    expect(card.key).toBe("lnkdrp-account");
    expect(card.timeToLiveSeconds).toBeGreaterThan(0);
    for (const c of card.components ?? []) assertComponent(c as Record<string, unknown>);
    const flat = JSON.stringify(card);
    expect(flat).toContain("Ada");
    expect(flat).toContain("Over limit · grace to 2026-09-24");
    expect(flat).toContain('"badgeLabel":"Pro"');
    expect(flat).toContain("12 / 10 shared");
    expect(flat).toContain("340 + on-demand");
    expect(flat).toContain("Agent connected (Claude Code)");
    expect(flat).toContain("No agent connected");
    expect(flat).toContain("/a/data/workspaces/64b000000000000000000011");
  });

  test("account card flags a pending deletion and a blocked workspace", () => {
    const ctx: CustomerContext = {
      ...FOUND,
      deletionRequestedAt: "2026-09-20T00:00:00.000Z",
      workspaces: [{ ...FOUND.workspaces[0]!, grace: { startedAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z", blockedAt: "2026-09-15T00:00:00.000Z" } }],
    };
    const flat = JSON.stringify(buildAccountCard(ctx));
    expect(flat).toContain("Deletion requested 2026-09-20");
    expect(flat).toContain('"badgeLabel":"Blocked"');
  });

  test("errors card shows code, route and status, and a clean bill when empty", () => {
    const card = buildErrorsCard(FOUND);
    for (const c of card.components ?? []) assertComponent(c as Record<string, unknown>);
    const flat = JSON.stringify(card);
    expect(flat).toContain("PDF_RENDER_FAILED");
    expect(flat).toContain("/api/uploads · 500 · Personal");
    expect(JSON.stringify(buildErrorsCard({ ...FOUND, errors: [] }))).toContain("No errors logged");
  });

  test("unknown customer gets a readable card, not an error", () => {
    const cards = buildCards(["lnkdrp-account", "lnkdrp-errors"], { found: false, email: "ghost@example.com" });
    expect(cards).toHaveLength(2);
    for (const card of cards) for (const c of card.components ?? []) assertComponent(c as Record<string, unknown>);
    expect(JSON.stringify(cards[0])).toContain("No lnkdrp account for ghost@example.com");
  });
});
