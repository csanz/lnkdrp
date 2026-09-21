/**
 * A forged burst must not become a wall of stranger-written text in the owner's inbox.
 *
 * `POST /api/share/:shareId/stats` accepts `botId`, `viewerName` and `viewerEmail` straight from an
 * anonymous request body. A `botId` nobody has used before mints a new `ShareView` row, and that row
 * carries the name and email the same caller supplied. The notification queue then hands one
 * member's claimed rows to `composeImmediateEmail` as a single document group, and the body used to
 * render one block per row — so the number of attacker-authored lines in one email was set by the
 * sender's `limitEventsPerMember` (20 by default, up to 200), not by anything the owner controls.
 *
 * `IMMEDIATE_MAX_VIEWERS` bounds that. The tests below pin the two halves of the bargain:
 * the list is capped, and nothing the owner is *told* gets smaller — the subject, the heading and
 * the preheader still count every reader, and the overflow is stated rather than silently dropped.
 * The last test is the legitimate-flow half: a real mailshot opened by more people than the cap
 * still produces its email, truncated rather than refused.
 */
import { describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { shareViewFind, shareVisitFind, shareLinkFind, docFind, userFind, cursorFind } = vi.hoisted(() => ({
  shareViewFind: vi.fn(),
  shareVisitFind: vi.fn(),
  shareLinkFind: vi.fn(),
  docFind: vi.fn(),
  userFind: vi.fn(),
  cursorFind: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { find: shareViewFind } }));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: { find: shareVisitFind, aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { find: shareLinkFind } }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: docFind } }));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: userFind } }));
vi.mock("@/lib/models/NotificationEmailCursor", () => ({
  NotificationEmailCursorModel: { find: cursorFind, bulkWrite: vi.fn(async () => ({})), updateOne: vi.fn(async () => ({})) },
}));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan: vi.fn(async () => "free") }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn(), debugWarn: vi.fn() }));

const vn = await import("@/lib/notifications/viewNotifications");

type NewViewerEvent = import("@/lib/notifications/viewNotifications").NewViewerEvent;
type ViewLinkInfo = import("@/lib/notifications/viewNotifications").ViewLinkInfo;
type ComposeContext = import("@/lib/notifications/viewNotifications").ComposeContext;

const T0 = new Date("2026-09-16T09:00:00.000Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

const DOC = { docId: "d1", title: "USAVX MEMO", pageCount: 12 };

function ctx(plan: "free" | "pro"): ComposeContext {
  return { appUrl: "https://app.example.com", offUrl: "https://app.example.com/api/notifications/views/off?t=tok", plan };
}

function link(overrides: Partial<ViewLinkInfo> = {}): ViewLinkInfo {
  return { shareId: "shareA", label: "Sequoia", audience: "Roelof", isDefault: false, createdDate: at(-600), ...overrides };
}

/** One forged reader: a fresh botId with a name and an email the caller wrote themselves. */
function forged(i: number, overrides: Partial<NewViewerEvent> = {}): NewViewerEvent {
  return {
    kind: "view",
    id: new Types.ObjectId().toString(),
    docId: "d1",
    shareId: "shareA",
    shareLinkId: null,
    botIdHash: `forged-${i}`,
    at: at(i),
    pagesSeen: 3,
    timeSpentMs: 60_000,
    viewerUserId: null,
    // The payload the stats route copies onto the ShareView row verbatim.
    viewerName: `PAYLOAD-${i}`,
    viewerEmail: `payload-${i}@attacker.example`,
    viewerUserName: null,
    ...overrides,
  };
}

/** How many forged names actually reached the message, across both renderings. */
function payloadsIn(email: { text: string; html: string }, total: number): { text: number; html: number } {
  let text = 0;
  let html = 0;
  for (let i = 0; i < total; i += 1) {
    if (email.text.includes(`PAYLOAD-${i}`)) text += 1;
    if (email.html.includes(`PAYLOAD-${i}`)) html += 1;
  }
  return { text, html };
}

describe("immediate view email: one burst cannot set the size of the message", () => {
  const BURST = 200; // the sender's ceiling on limitEventsPerMember

  test("a burst of forged readers is capped at IMMEDIATE_MAX_VIEWERS named lines (Pro)", () => {
    const events = Array.from({ length: BURST }, (_, i) => forged(i));
    const email = vn.composeImmediateEmail({
      ctx: ctx("pro"),
      doc: DOC,
      events,
      links: new Map([["shareA", link()]]),
    });

    const seen = payloadsIn(email, BURST);
    expect(seen.text).toBeLessThanOrEqual(vn.IMMEDIATE_MAX_VIEWERS);
    expect(seen.html).toBeLessThanOrEqual(vn.IMMEDIATE_MAX_VIEWERS);
    // And the cap is the binding constraint, not an accident of the fixture.
    expect(seen.text).toBe(vn.IMMEDIATE_MAX_VIEWERS);
    expect(seen.html).toBe(vn.IMMEDIATE_MAX_VIEWERS);
  });

  test("the owner is still told the true total, and told that the list was cut", () => {
    const events = Array.from({ length: BURST }, (_, i) => forged(i));
    const email = vn.composeImmediateEmail({
      ctx: ctx("pro"),
      doc: DOC,
      events,
      links: new Map([["shareA", link()]]),
    });

    // The count the owner acts on is unchanged: cap the list, never the totals.
    expect(email.subject).toBe(`${BURST} people opened "USAVX MEMO"`);
    expect(email.text).toContain(`${BURST} people opened "USAVX MEMO"`);
    const overflow = BURST - vn.IMMEDIATE_MAX_VIEWERS;
    expect(email.text).toContain(`${overflow} more readers are included in the count above`);
    expect(email.html).toContain(`${overflow} more readers are included in the count above`);
  });

  test("the cap holds on the multi-link rendering too, where each reader costs a block and a table", () => {
    // Half the burst on a second link forces the per-link branch, which renders more per reader.
    const events = Array.from({ length: BURST }, (_, i) => forged(i, i % 2 ? { shareId: "shareB" } : {}));
    const email = vn.composeImmediateEmail({
      ctx: ctx("pro"),
      doc: DOC,
      events,
      links: new Map([
        ["shareA", link()],
        ["shareB", link({ shareId: "shareB", label: "Benchmark", audience: "Eric" })],
      ]),
    });

    const seen = payloadsIn(email, BURST);
    expect(seen.text).toBe(vn.IMMEDIATE_MAX_VIEWERS);
    expect(seen.html).toBe(vn.IMMEDIATE_MAX_VIEWERS);
  });

  test("Free never names anyone, and the cap still bounds the per-reader lines", () => {
    const events = Array.from({ length: BURST }, (_, i) => forged(i));
    const email = vn.composeImmediateEmail({
      ctx: ctx("free"),
      doc: DOC,
      events,
      links: new Map([["shareA", link()]]),
    });

    expect(payloadsIn(email, BURST)).toEqual({ text: 0, html: 0 });
    // One timestamp line per listed reader and no more.
    expect(email.text.split("\n").filter((l) => l.trim().endsWith("UTC")).length).toBeLessThanOrEqual(
      vn.IMMEDIATE_MAX_VIEWERS + 2, // + the "When"-style rows the header/footer may contribute
    );
  });

  test("a genuine burst under the cap is untouched — the email is truncated, never refused", () => {
    const events = Array.from({ length: vn.IMMEDIATE_MAX_VIEWERS }, (_, i) => forged(i));
    const email = vn.composeImmediateEmail({
      ctx: ctx("pro"),
      doc: DOC,
      events,
      links: new Map([["shareA", link()]]),
    });

    expect(payloadsIn(email, vn.IMMEDIATE_MAX_VIEWERS)).toEqual({
      text: vn.IMMEDIATE_MAX_VIEWERS,
      html: vn.IMMEDIATE_MAX_VIEWERS,
    });
    expect(email.text).not.toContain("included in the count above");

    // One over the cap: still an email, still every reader in the total, one name held back.
    const overOne = Array.from({ length: vn.IMMEDIATE_MAX_VIEWERS + 1 }, (_, i) => forged(i));
    const cut = vn.composeImmediateEmail({ ctx: ctx("pro"), doc: DOC, events: overOne, links: new Map([["shareA", link()]]) });
    expect(cut.subject).toBe(`${vn.IMMEDIATE_MAX_VIEWERS + 1} people opened "USAVX MEMO"`);
    expect(cut.text).toContain("1 more reader is included in the count above");
    expect(payloadsIn(cut, vn.IMMEDIATE_MAX_VIEWERS + 1).text).toBe(vn.IMMEDIATE_MAX_VIEWERS);
  });

  test("a single real reader is unchanged: no cap wording, full detail", () => {
    const email = vn.composeImmediateEmail({
      ctx: ctx("pro"),
      doc: DOC,
      events: [forged(0, { viewerName: "Roelof Botha", viewerEmail: "roelof@sequoia.example" })],
      links: new Map([["shareA", link()]]),
    });
    expect(email.subject).toBe(`Sequoia opened "USAVX MEMO"`);
    expect(email.text).toContain("Roelof Botha");
    expect(email.text).not.toContain("included in the count above");
  });
});
