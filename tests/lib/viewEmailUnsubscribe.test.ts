/**
 * The unsubscribe link in a view email was a one-GET kill switch.
 *
 * `GET /api/notifications/views/off?t=<token>` ran the write — `viewEmailMode: "off"` — on any
 * correctly signed, unexpired token. That URL is not only in the `List-Unsubscribe` header, where
 * only mail infrastructure sees it; `viewNotifications` also renders it into the visible footer of
 * every view email, as plain text and as an anchor. So anything that opens links in a mail body —
 * a corporate link scanner, an antivirus proxy, a prefetching client, a colleague opening a
 * forwarded copy — turned off a member's view notifications, and the member only found out by
 * noticing they had stopped hearing when outsiders opened their documents.
 *
 * The fix keeps both real flows working and moves the write behind an explicit act:
 *
 * - GET renders the current state plus a confirm button; it never writes.
 * - The button posts the RFC 8058 one-click body back to the same URL, so the human path and the
 *   mail provider's `List-Unsubscribe-Post` share one write path.
 * - A provider's POST still gets its bodyless status; a browser's POST gets the confirmation page.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const SECRET = "test-notification-token-secret";
const MEMBERSHIP = new Types.ObjectId();
const ORG = new Types.ObjectId();

let storedMode: "off" | "daily" | "immediate" = "daily";
let membershipExists = true;

const findOneAndUpdate = vi.fn((..._a: unknown[]) => chain(membershipExists ? { _id: MEMBERSHIP, orgId: ORG } : null));
const membershipFindOne = vi.fn((..._a: unknown[]) =>
  chain(membershipExists ? { _id: MEMBERSHIP, orgId: ORG, viewEmailMode: storedMode } : null),
);
const updateOne = vi.fn(async (..._a: unknown[]) => ({ matchedCount: membershipExists ? 1 : 0 }));

function chain(value: unknown) {
  return { select: () => chain(value), lean: async () => value };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: {
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
    findOne: (...a: unknown[]) => membershipFindOne(...a),
    updateOne: (...a: unknown[]) => updateOne(...a),
  },
}));
vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: () => chain({ _id: ORG, name: "Sequoia" }) },
}));

const { createViewEmailsOffToken } = await import("@/lib/notifications/viewEmailToken");
const route = await import("@/app/api/notifications/views/off/route");

const URL_BASE = "https://lnkdrp.com/api/notifications/views/off";

/** A live link exactly as an email carries it. */
function liveUrl(): string {
  return `${URL_BASE}?t=${encodeURIComponent(createViewEmailsOffToken(MEMBERSHIP.toString()))}`;
}

/** A link from an email older than the token lifetime: correctly signed, past its expiry. */
function expiredUrl(): string {
  const token = createViewEmailsOffToken(MEMBERSHIP.toString(), { now: new Date(Date.now() - 60_000), ttlMs: 1_000 });
  return `${URL_BASE}?t=${encodeURIComponent(token)}`;
}

/** What a browser sends when a person submits the confirm form. */
const BROWSER_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "content-type": "application/x-www-form-urlencoded",
};

/** What Gmail/Yahoo/Apple Mail send for RFC 8058 one-click. */
const PROVIDER_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

beforeEach(() => {
  vi.stubEnv("LNKDRP_NOTIFICATION_TOKEN_SECRET", SECRET);
  vi.clearAllMocks();
  storedMode = "daily";
  membershipExists = true;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET the unsubscribe link", () => {
  test("a fetch of the link in the email body changes nothing", async () => {
    const res = await route.GET(new Request(liveUrl()));

    // This is the whole finding: a link scanner, proxy or prefetcher issuing a plain GET used to
    // disable the member's notifications on the spot.
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  test("the page asks, and its button carries the same one-click body a provider would post", async () => {
    const url = liveUrl();
    const html = await (await route.GET(new Request(url))).text();

    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
    // The form posts back to this same URL with the token intact, so the POST handler can verify it.
    expect(html).toContain(`action="?t=${new URL(url).searchParams.get("t")!}"`);
    expect(html).toContain("Turn off view emails");
    // Still offers the signed-in route out, and still says nothing about any other member.
    expect(html).toContain("/dashboard?tab=account#email-preferences");
  });

  test("the confirm form is allowed by the page's own CSP", async () => {
    const res = await route.GET(new Request(liveUrl()));
    const csp = res.headers.get("content-security-policy") ?? "";

    // `form-action 'none'` would silently swallow the submission in the browser.
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("a membership already off is told so, with no button and no write", async () => {
    storedMode = "off";
    const res = await route.GET(new Request(liveUrl()));
    const html = await res.text();

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(html).toContain("View emails are off");
    expect(html).not.toContain("<form");
  });

  test("an expired link still reports the current state and writes nothing", async () => {
    const res = await route.GET(new Request(expiredUrl()));
    const html = await res.text();

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(html).toContain("This link has expired");
    expect(html).not.toContain("<form");
  });

  test("a forged or truncated token gets the neutral page and no lookup", async () => {
    const res = await route.GET(new Request(`${URL_BASE}?t=not-a-token`));

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(membershipFindOne).not.toHaveBeenCalled();
    expect(await res.text()).toContain("This link is not valid");
  });

  test("HEAD probes write nothing either", async () => {
    const res = await route.HEAD(new Request(liveUrl(), { method: "HEAD" }));

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe("POST: the one write path", () => {
  test("a person confirming in the browser turns view emails off and lands on a page", async () => {
    const res = await route.POST(
      new Request(liveUrl(), { method: "POST", headers: BROWSER_HEADERS, body: "List-Unsubscribe=One-Click" }),
    );

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate.mock.calls[0]?.[1]).toEqual({ $set: { viewEmailMode: "off" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("View emails are off");
  });

  test("the mail provider's one-click POST is unchanged: it writes and answers bodyless", async () => {
    const res = await route.POST(
      new Request(liveUrl(), { method: "POST", headers: PROVIDER_HEADERS, body: "List-Unsubscribe=One-Click" }),
    );

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0]?.[1]).toEqual({ $set: { viewEmailMode: "off" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("a POST without the one-click body writes nothing", async () => {
    const res = await route.POST(new Request(liveUrl(), { method: "POST", headers: PROVIDER_HEADERS, body: "off=1" }));

    expect(res.status).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("an expired token cannot be confirmed, from a browser or a provider", async () => {
    const fromBrowser = await route.POST(
      new Request(expiredUrl(), { method: "POST", headers: BROWSER_HEADERS, body: "List-Unsubscribe=One-Click" }),
    );
    const fromProvider = await route.POST(
      new Request(expiredUrl(), { method: "POST", headers: PROVIDER_HEADERS, body: "List-Unsubscribe=One-Click" }),
    );

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(await fromBrowser.text()).toContain("This link has expired");
    expect(fromProvider.status).toBe(400);
  });

  test("a membership removed since the email went out reveals nothing", async () => {
    membershipExists = false;
    const res = await route.POST(
      new Request(liveUrl(), { method: "POST", headers: BROWSER_HEADERS, body: "List-Unsubscribe=One-Click" }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link is not valid");
  });
});
