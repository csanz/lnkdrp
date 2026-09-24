import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { readFileSync } from "node:fs";
import path from "node:path";

/** A Mongoose query stand-in: chainable, resolves `rows` from `.lean()`. */
function chain(rows: unknown[]) {
  const q = {
    sort: () => q,
    limit: () => q,
    select: () => q,
    lean: async () => rows,
  };
  return q;
}

const { shareViewFind, shareVisitFind, shareVisitAggregate, shareLinkFind, docFind, userFind, cursorFind, cursorBulkWrite, cursorUpdateOne, getWorkspacePlan } =
  vi.hoisted(() => ({
    shareViewFind: vi.fn(),
    shareVisitFind: vi.fn(),
    shareVisitAggregate: vi.fn(async (): Promise<unknown[]> => []),
    shareLinkFind: vi.fn(),
    docFind: vi.fn(),
    userFind: vi.fn(),
    cursorFind: vi.fn(),
    cursorBulkWrite: vi.fn(async (..._args: unknown[]) => ({})),
    cursorUpdateOne: vi.fn(async (..._args: unknown[]) => ({})),
    getWorkspacePlan: vi.fn(async (): Promise<string> => "free"),
  }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { find: shareViewFind } }));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: { find: shareVisitFind, aggregate: shareVisitAggregate } }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { find: shareLinkFind } }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: docFind } }));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: userFind } }));
vi.mock("@/lib/models/NotificationEmailCursor", () => ({
  NotificationEmailCursorModel: { find: cursorFind, bulkWrite: cursorBulkWrite, updateOne: cursorUpdateOne },
}));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn(), debugWarn: vi.fn() }));

const vn = await import("@/lib/notifications/viewNotifications");
const { verifyViewEmailsOffToken } = await import("@/lib/notifications/viewEmailToken");

type NewViewerEvent = import("@/lib/notifications/viewNotifications").NewViewerEvent;
type ReturnEvent = import("@/lib/notifications/viewNotifications").ReturnEvent;
type ViewLinkInfo = import("@/lib/notifications/viewNotifications").ViewLinkInfo;
type ViewDocInfo = import("@/lib/notifications/viewNotifications").ViewDocInfo;

const APP = "https://app.example.com";
const T0 = new Date("2026-09-16T09:00:00.000Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

function view(overrides: Partial<NewViewerEvent> = {}): NewViewerEvent {
  return {
    kind: "view",
    id: new Types.ObjectId().toString(),
    docId: "d1",
    shareId: "shareA",
    shareLinkId: null,
    botIdHash: "bot1",
    at: at(1),
    pagesSeen: 4,
    timeSpentMs: 200_000,
    viewerUserId: null,
    viewerName: null,
    viewerEmail: null,
    viewerUserName: null,
    ...overrides,
  };
}

function ret(overrides: Partial<ReturnEvent> = {}): ReturnEvent {
  return {
    kind: "return",
    id: new Types.ObjectId().toString(),
    docId: "d1",
    shareId: "shareA",
    shareLinkId: null,
    botIdHash: "bot9",
    at: at(2),
    firstViewAt: at(-600),
    firstVisitAt: at(-600),
    pagesSeen: 2,
    timeSpentMs: 30_000,
    viewerUserId: null,
    viewerName: null,
    viewerEmail: null,
    viewerUserName: null,
    ...overrides,
  };
}

function link(overrides: Partial<ViewLinkInfo> = {}): ViewLinkInfo {
  return { shareId: "shareA", label: "Sequoia", audience: "Roelof", isDefault: false, createdDate: at(-600), ...overrides };
}

const DOC = { docId: "d1", title: "USAVX MEMO", pageCount: 12 };

describe("mode and text helpers", () => {
  test("normalizeViewEmailMode treats missing and unknown as immediate", () => {
    // The default is the alert, not the report: knowing someone is reading your deck is worth
    // something while they still are. A member who chose `daily` or `off` has it stored and is
    // not touched by this.
    expect(vn.normalizeViewEmailMode(undefined)).toBe("immediate");
    expect(vn.normalizeViewEmailMode(null)).toBe("immediate");
    expect(vn.normalizeViewEmailMode("weekly")).toBe("immediate");
    expect(vn.normalizeViewEmailMode("off")).toBe("off");
    expect(vn.normalizeViewEmailMode("daily")).toBe("daily");
    expect(vn.normalizeViewEmailMode("immediate")).toBe("immediate");
  });

  test("sanitizeInline strips line breaks and control characters and truncates", () => {
    expect(vn.sanitizeInline("Deck\r\nBcc: evil@x.com")).toBe("Deck Bcc: evil@x.com");
    expect(vn.sanitizeInline("a\u2028b\u0000c\td")).toBe("a b c d");
    expect(vn.sanitizeInline("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(vn.sanitizeInline(42)).toBe("");
  });

  test("escapeHtml escapes every attribute-breaking character", () => {
    expect(vn.escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  });

  test("realLinkLabel ignores the default link and its internal name", () => {
    expect(vn.realLinkLabel(link())).toBe("Sequoia");
    expect(vn.realLinkLabel(link({ isDefault: true }))).toBeNull();
    expect(vn.realLinkLabel(link({ label: "Default link" }))).toBeNull();
    expect(vn.realLinkLabel(link({ label: "default LINK" }))).toBeNull();
    expect(vn.realLinkLabel(link({ label: "  " }))).toBeNull();
    expect(vn.realLinkLabel(undefined)).toBeNull();
    expect(vn.linkDisplayName(undefined)).toBe("Default link");
  });

  test("formatDuration", () => {
    expect(vn.formatDuration(500)).toBeNull();
    expect(vn.formatDuration(45_000)).toBe("45s");
    expect(vn.formatDuration(200_000)).toBe("3m 20s");
    expect(vn.formatDuration(120_000)).toBe("2m");
    expect(vn.formatDuration(3_900_000)).toBe("1h 5m");
    expect(vn.formatDuration(Number.NaN)).toBeNull();
  });

  test("formatWhenUtc", () => {
    expect(vn.formatWhenUtc(new Date("2026-09-16T09:40:00Z"))).toBe("Sep 16, 2026, 09:40 UTC");
  });

  test("formatHowFar with and without a known page count", () => {
    expect(vn.formatHowFar({ pagesSeen: 4, timeSpentMs: 200_000 }, 12)).toBe("4 of 12 pages · 3m 20s");
    expect(vn.formatHowFar({ pagesSeen: 4, timeSpentMs: 0 }, null)).toBe("4 pages seen");
    expect(vn.formatHowFar({ pagesSeen: 1, timeSpentMs: 0 }, null)).toBe("1 page seen");
    expect(vn.formatHowFar({ pagesSeen: 0, timeSpentMs: 0 }, 12)).toBeNull();
  });

  test("viewerDisplayName order: given name, email, signed-in user name", () => {
    expect(vn.viewerDisplayName(view({ viewerName: "Jane", viewerEmail: "j@x.com", viewerUserName: "U" }))).toBe("Jane");
    expect(vn.viewerDisplayName(view({ viewerEmail: "j@x.com", viewerUserName: "U" }))).toBe("j@x.com");
    expect(vn.viewerDisplayName(view({ viewerUserId: "u1", viewerUserName: "Uma" }))).toBe("Uma");
    expect(vn.viewerDisplayName(view())).toBeNull();
  });

  test("first-view honesty: within ten minutes of link creation; anonymity only checked on Pro", () => {
    const fresh = link({ createdDate: at(-5) });
    expect(vn.needsFirstViewHonesty(view({ at: at(0) }), fresh, "pro")).toBe(true);
    expect(vn.needsFirstViewHonesty(view({ at: at(0), viewerEmail: "a@b.c" }), fresh, "pro")).toBe(false);
    expect(vn.needsFirstViewHonesty(view({ at: at(0), viewerEmail: "a@b.c" }), fresh, "free")).toBe(true);
    expect(vn.needsFirstViewHonesty(view({ at: at(6) }), fresh, "pro")).toBe(false);
    expect(vn.needsFirstViewHonesty(view({ at: at(0) }), link({ createdDate: null }), "pro")).toBe(false);
    expect(vn.needsFirstViewHonesty(view({ at: at(0) }), undefined, "free")).toBe(false);
  });

  test("urls encode ids", () => {
    expect(vn.buildMetricsUrl(APP, "d 1", "a&b")).toBe(`${APP}/doc/d%201/metrics?shareId=a%26b`);
    expect(vn.buildMetricsUrl(APP, "d1")).toBe(`${APP}/doc/d1/metrics`);
    expect(vn.buildPreferencesUrl(APP)).toBe(`${APP}/dashboard?tab=notifications#email-preferences`);
  });
});

describe("windows, caps, grouping and cursor math", () => {
  test("eventsInWindow is (cursor, now] and sorted", () => {
    const evs = [view({ at: at(3) }), view({ at: at(0) }), view({ at: at(1) }), view({ at: at(10) })];
    const out = vn.eventsInWindow(evs, at(0), at(3));
    expect(out.map((e) => e.at.getTime())).toEqual([at(1).getTime(), at(3).getTime()]);
  });

  test("capAtTimestampBoundary never splits a millisecond", () => {
    const evs = [view({ at: at(1) }), view({ at: at(2) }), view({ at: at(2) }), view({ at: at(3) })];
    expect(vn.capAtTimestampBoundary(evs, 4)).toEqual({ batch: evs, truncated: false });
    const two = vn.capAtTimestampBoundary(evs, 2);
    expect(two.batch).toHaveLength(1);
    expect(two.truncated).toBe(true);
    const three = vn.capAtTimestampBoundary(evs, 3);
    expect(three.batch).toHaveLength(3);
  });

  test("capAtTimestampBoundary takes the whole tied group rather than nothing", () => {
    const evs = [view({ at: at(1) }), view({ at: at(1) }), view({ at: at(1) }), view({ at: at(2) })];
    const out = vn.capAtTimestampBoundary(evs, 2);
    expect(out.batch).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  test("cutLoadAtBoundary: a covered load keeps everything; a cut load stops before the first excluded row", () => {
    const evs = [view({ at: at(1) }), view({ at: at(2) }), view({ at: at(2) })];
    expect(vn.cutLoadAtBoundary(evs, evs.map((e) => e.at), 3)).toEqual({ batch: evs, truncated: false, horizon: null });
    // Four raw rows fetched with a cap of 3: the 4th (at 2) is the boundary, so both rows at 2 wait.
    const cut = vn.cutLoadAtBoundary(evs, [at(1), at(2), at(2), at(2)], 3);
    expect(cut.batch).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(cut.horizon).toEqual(new Date(at(2).getTime() - 1));
    // A single millisecond holding more than the cap: keep it rather than stall.
    const tied = vn.cutLoadAtBoundary(evs.slice(1), [at(2), at(2), at(2)], 2);
    expect(tied.batch).toHaveLength(2);
    expect(tied.horizon).toEqual(at(2));
    // Unparseable raw rows still count toward the cut.
    const skipped = vn.cutLoadAtBoundary([view({ at: at(1) })], [at(1), at(3), at(4)], 2);
    expect(skipped.batch).toHaveLength(1);
    expect(skipped.horizon).toEqual(new Date(at(4).getTime() - 1));
  });

  test("settledUntil and memberWindowStart", () => {
    expect(vn.settledUntil(at(10))).toEqual(new Date(at(10).getTime() - vn.VIEW_EVENT_SETTLE_MS));
    // Immediate never looks back more than an hour; daily goes back to its cursor within the lookback.
    expect(vn.memberWindowStart("immediate", at(-600), at(0), 7)).toEqual(new Date(at(0).getTime() - vn.IMMEDIATE_MAX_LOOKBACK_MS));
    expect(vn.memberWindowStart("immediate", at(-10), at(0), 7)).toEqual(at(-10));
    expect(vn.memberWindowStart("daily", at(-600), at(0), 7)).toEqual(at(-600));
    expect(vn.memberWindowStart("daily", at(-20_000), at(0), 7)).toEqual(new Date(at(0).getTime() - 7 * 24 * 3600_000));
  });

  test("combineHorizons", () => {
    expect(vn.combineHorizons(null, at(5), at(2))).toEqual(at(2));
    expect(vn.combineHorizons(null, null)).toBeNull();
  });

  test("groupByDocument orders documents by earliest event", () => {
    const evs = [view({ docId: "b", at: at(5) }), view({ docId: "a", at: at(2) }), view({ docId: "b", at: at(1) })];
    const groups = vn.groupByDocument(evs);
    expect(groups.map((g) => g.docId)).toEqual(["b", "a"]);
    expect(groups[0].events.map((e) => e.at)).toEqual([at(1), at(5)]);
  });

  test("groupByLink", () => {
    const groups = vn.groupByLink([view({ shareId: "x", at: at(2) }), view({ shareId: "y", at: at(1) }), view({ shareId: "x", at: at(3) })]);
    expect(groups.map((g) => [g.shareId, g.events.length])).toEqual([
      ["y", 1],
      ["x", 2],
    ]);
  });

  test("nextCursorAfterSends: all sent advances to the latest event", () => {
    const next = vn.nextCursorAfterSends(at(0), [
      { events: [view({ at: at(1) }), view({ at: at(4) })], sent: true },
      { events: [view({ at: at(2) })], sent: true },
    ]);
    expect(next).toEqual(at(4));
  });

  test("nextCursorAfterSends: a failed document caps the cursor 1 ms before its earliest event", () => {
    const next = vn.nextCursorAfterSends(at(0), [
      { events: [view({ at: at(1) }), view({ at: at(5) })], sent: true },
      { events: [view({ at: at(3) }), view({ at: at(4) })], sent: false },
    ]);
    expect(next).toEqual(new Date(at(3).getTime() - 1));
    // The failed events are still after the new cursor, so the next tick retries them.
    expect(vn.eventsInWindow([view({ at: at(3) })], next!, at(10))).toHaveLength(1);
  });

  test("nextCursorAfterSends: nothing sent, or nothing to move, leaves the cursor", () => {
    expect(vn.nextCursorAfterSends(at(0), [])).toBeNull();
    expect(vn.nextCursorAfterSends(at(0), [{ events: [view({ at: new Date(at(0).getTime() + 1) })], sent: false }])).toBeNull();
    expect(vn.nextCursorAfterSends(at(5), [{ events: [view({ at: at(1) })], sent: true }])).toBeNull();
  });

  test("isReturnVisit: a later visit than the reader's first, or long after their first view", () => {
    // First-time reader: first view and first visit land together.
    expect(vn.isReturnVisit({ at: at(0), firstViewAt: at(0), firstVisitAt: at(0) })).toBe(false);
    // Same reader opens a new tab two minutes later, same day: a return.
    expect(vn.isReturnVisit({ at: at(2), firstViewAt: at(0), firstVisitAt: at(0) })).toBe(true);
    // First visit row written late (30 s) with no earlier visit: still the first open.
    expect(vn.isReturnVisit({ at: new Date(at(0).getTime() + 30_000), firstViewAt: at(0), firstVisitAt: new Date(at(0).getTime() + 30_000) })).toBe(false);
    // Reader from before per-visit tracking: their first visit row is this one, but the view is old.
    expect(vn.isReturnVisit({ at: at(600), firstViewAt: at(0), firstVisitAt: at(600) })).toBe(true);
    expect(vn.isReturnVisit({ at: at(600), firstViewAt: null, firstVisitAt: at(0) })).toBe(false);
  });

  test("selectReturns keeps return visits only, one per reader (their latest)", () => {
    const visits = [
      ret({ botIdHash: "r1", at: at(1), firstViewAt: at(-100), firstVisitAt: at(-100) }),
      ret({ botIdHash: "r1", at: at(3), firstViewAt: at(-100), firstVisitAt: at(-100) }),
      ret({ botIdHash: "r2", at: at(2), firstViewAt: at(0), firstVisitAt: at(0) }),
      ret({ botIdHash: "new", at: at(1), firstViewAt: at(1), firstVisitAt: at(1) }),
      ret({ botIdHash: "orphan", at: at(2), firstViewAt: null, firstVisitAt: null }),
    ];
    const out = vn.selectReturns(visits);
    expect(out.map((r) => [r.botIdHash, r.at.getTime()])).toEqual([
      ["r2", at(2).getTime()],
      ["r1", at(3).getTime()],
    ]);
  });
});

describe("email composition", () => {
  const ctxFree = { appUrl: APP, offUrl: `${APP}/api/notifications/views/off?t=tok`, plan: "free" as const };
  const ctxPro = { ...ctxFree, plan: "pro" as const };
  const links = new Map([["shareA", link()]]);

  test("immediate subjects", () => {
    expect(vn.immediateSubject("USAVX MEMO", [view()], links)).toBe('Sequoia opened "USAVX MEMO"');
    expect(vn.immediateSubject("USAVX MEMO", [view({ shareId: "dflt" })], new Map([["dflt", link({ shareId: "dflt", isDefault: true })]]))).toBe(
      'Someone opened "USAVX MEMO"',
    );
    expect(vn.immediateSubject("USAVX MEMO", [view({ shareId: "nolink" })], links)).toBe('Someone opened "USAVX MEMO"');
    expect(vn.immediateSubject("USAVX MEMO", [view(), view({ botIdHash: "b2" })], links)).toBe('2 people opened "USAVX MEMO"');
    expect(vn.immediateSubject("Deck\nBcc: x@y.z", [view()], links)).toBe('Sequoia opened "Deck Bcc: x@y.z"');
  });

  test("digest subjects say today, or since a date for a longer window, never yesterday", () => {
    expect(vn.digestSubject(1, 0)).toBe("1 person opened your documents today");
    expect(vn.digestSubject(3, 2)).toBe("3 people opened your documents today");
    expect(vn.digestSubject(0, 1)).toBe("1 person came back to your documents today");
    expect(vn.digestSubject(0, 2, "since Sep 12")).toBe("2 people came back to your documents since Sep 12");
    const digestAt = new Date("2026-09-16T23:00:00Z");
    expect(vn.digestPeriodPhrase(new Date("2026-09-15T23:00:00Z"), digestAt)).toBe("today");
    expect(vn.digestPeriodPhrase(new Date("2026-09-16T12:00:00Z"), digestAt)).toBe("today");
    expect(vn.digestPeriodPhrase(new Date("2026-09-12T23:05:00Z"), digestAt)).toBe("since Sep 12");
  });

  test("immediate Pro email names the viewer, pages and time, with the deep link and footer", () => {
    const ev = view({ viewerName: "Jane Doe", viewerEmail: "jane@fund.com" });
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [ev], links });
    expect(email.subject).toBe('Sequoia opened "USAVX MEMO"');
    expect(email.text).toContain('Jane Doe opened "USAVX MEMO"');
    expect(email.text).toContain("Link: Sequoia");
    expect(email.text).toContain("Audience: Roelof");
    expect(email.text).toContain("When: Sep 16, 2026, 09:01 UTC");
    expect(email.text).toContain("How far: 4 of 12 pages · 3m 20s so far");
    // Always true for immediate emails, so it is not printed.
    expect(email.text).not.toContain("First open");
    // One reader, so the action is that reader's page rather than the document's list.
    expect(email.text).toContain(`See what this reader read: ${APP}/doc/d1/metrics/viewer/a_bot1`);
    expect(email.text).toContain(vn.VIEW_EMAIL_FOOTER_REASON);
    expect(email.text).toContain(`Turn off these emails: ${ctxPro.offUrl}`);
    expect(email.text).toContain(`Change how often: ${APP}/dashboard?tab=notifications#email-preferences`);
    expect(email.text).not.toContain(vn.PRO_IDENTITY_LINE);
    expect(email.html).toContain("Jane Doe");
    expect(email.html).toContain(`href="${APP}/doc/d1/metrics/viewer/a_bot1"`);
    expect(email.html).toContain("Turn off these emails");
    expect(email.html).toContain("Change how often");
  });

  test("a data room's reader link is project-scoped, and addresses the person not the file", () => {
    // Two things this gets wrong easily. A read through a project link belongs to the PROJECT, so
    // a /doc/ address for that reader is a page that says "no reader by that id". And the
    // analytics key on a project link is `<digest>.<docId>` — one row per reader per document —
    // while the page is addressed by the bare digest.
    const room = link({ shareId: "roomA", projectId: "p9", label: "Lite Data Room" });
    const ev = view({ shareId: "roomA", botIdHash: "digest123.6aac2b58", viewerName: "Jane Doe" });
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [ev], links: new Map([["roomA", room]]) });
    expect(email.text).toContain(`See what this reader read: ${APP}/project/p9/metrics/viewer/a_digest123`);
    expect(email.text).not.toContain("/doc/d1/metrics/viewer");
    expect(email.text).not.toContain("6aac2b58");
  });

  test("a signed-in reader is addressed by user id", () => {
    const uid = new Types.ObjectId().toString();
    const ev = view({ viewerUserId: uid, viewerUserName: "Jane Account" });
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [ev], links });
    expect(email.text).toContain(`${APP}/doc/d1/metrics/viewer/u_${uid}`);
  });

  test("several readers keep the document link, because that is where a list lives", () => {
    const email = vn.composeImmediateEmail({
      ctx: ctxPro,
      doc: DOC,
      events: [view(), view({ botIdHash: "bot2" })],
      links,
    });
    expect(email.text).toContain(`See what they read: ${APP}/doc/d1/metrics?shareId=shareA`);
    expect(email.text).not.toContain("/metrics/viewer/");
  });

  test("a typed-in name is marked as unverified; an account's name is not", () => {
    // Anyone holding the link can POST any viewerName to the stats endpoint, and an email gets
    // forwarded and acted on. The name still shows — it is the product — it just stops being
    // printed in the typeface of a fact.
    const told = vn.composeImmediateEmail({
      ctx: ctxPro,
      doc: DOC,
      events: [view({ viewerName: "Jane Doe", viewerEmail: "jane@fund.com" })],
      links,
    });
    expect(told.text).toContain("Jane Doe");
    expect(told.text).toContain(vn.VOLUNTEERED_IDENTITY_NOTE);

    const proved = vn.composeImmediateEmail({
      ctx: ctxPro,
      doc: DOC,
      events: [view({ viewerUserId: new Types.ObjectId().toString(), viewerUserName: "Jane Account" })],
      links,
    });
    expect(proved.text).toContain("Jane Account");
    expect(proved.text).not.toContain(vn.VOLUNTEERED_IDENTITY_NOTE);
  });

  test("Free never carries the unverified note, because it never printed a name to qualify", () => {
    const email = vn.composeImmediateEmail({
      ctx: ctxFree,
      doc: DOC,
      events: [view({ viewerName: "Jane Doe", viewerEmail: "jane@fund.com" })],
      links,
    });
    expect(email.text).not.toContain(vn.VOLUNTEERED_IDENTITY_NOTE);
    expect(email.text).not.toContain("Jane Doe");
  });

  test("immediate Free email never carries identity, pages or time anywhere", () => {
    const ev = view({
      viewerName: "Jane Doe",
      viewerEmail: "jane@fund.com",
      viewerUserId: new Types.ObjectId().toString(),
      viewerUserName: "Jane Account",
    });
    const email = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [ev, view({ botIdHash: "b2", viewerName: "Bob" })], links });
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("Jane");
      expect(part).not.toContain("jane@fund.com");
      expect(part).not.toContain("Bob");
      expect(part).not.toContain("3m 20s");
      expect(part).not.toContain("of 12 pages");
    }
    expect(email.text).toContain("Link: Sequoia");
    expect(email.text).toContain(vn.PRO_IDENTITY_LINE);
    expect(email.html).toContain(vn.PRO_IDENTITY_LINE);
    expect(email.text).toContain(`See what they read: ${APP}/doc/d1/metrics?shareId=shareA`);
    // The upsell is a secondary button, attributed to the email; the sentence is its caption. With
    // two viewers the primary already went to the metrics page, so this one goes to pricing.
    expect(email.text).toContain(`See who opened it: ${APP}/pricing?from=view_email`);
    expect(email.html).toMatch(
      /<td align="center" bgcolor="#ffffff" style="[^"]*padding:10px 16px;[^"]*"><a href="https:\/\/app\.example\.com\/pricing\?from=view_email" style="[^"]*">See who opened it<\/a>/,
    );
  });

  test("immediate Free single viewer: primary to the reader page, upsell to the metrics teaser", () => {
    const email = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [view()], links });
    expect(email.text).toContain(`${vn.READER_ACTION_LABEL}: ${APP}/doc/d1/metrics/viewer/a_bot1`);
    expect(email.text).toContain(`See who opened it: ${APP}/doc/d1/metrics?shareId=shareA&from=view_email`);
    expect(email.html).toContain(`href="${APP}/doc/d1/metrics?shareId=shareA&amp;from=view_email"`);
  });

  test("immediate Free single viewer on a named link reads 'Someone on the X link'", () => {
    const email = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [view()], links });
    expect(email.text.split("\n")[0]).toBe('Someone on the Sequoia link opened "USAVX MEMO"');
  });

  test("several links on one document deep-link to the document, not one link", () => {
    const multi = new Map([
      ["shareA", link()],
      ["shareB", link({ shareId: "shareB", label: "a16z", audience: null })],
    ]);
    const email = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [view(), view({ shareId: "shareB", botIdHash: "b2" })], links: multi });
    expect(email.subject).toBe('2 people opened "USAVX MEMO"');
    expect(email.text).toContain(`See what they read: ${APP}/doc/d1/metrics\n`);
  });

  test("honesty line for an anonymous open soon after the link was created", () => {
    const fresh = new Map([["shareA", link({ createdDate: at(-2) })]]);
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view({ at: at(0) })], links: fresh });
    expect(email.text).toContain(vn.FIRST_VIEW_HONESTY_LINE);
    expect(email.html).toContain("If this was you checking the link, sign in first next time and we&#39;ll know not to count it.");
    const later = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view({ at: at(0) })], links });
    expect(later.text).not.toContain(vn.FIRST_VIEW_HONESTY_LINE);
  });

  test("user content cannot break out of its element in html", () => {
    const evil = "</h1><script>alert(1)</script>";
    const evilLinks = new Map([["shareA", link({ label: `"><img src=x>`, audience: "<b>x</b>" })]]);
    const email = vn.composeImmediateEmail({
      ctx: ctxPro,
      doc: { ...DOC, title: evil },
      events: [view({ viewerName: "<i>Jane</i>" })],
      links: evilLinks,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x>");
    expect(email.html).not.toContain("<b>x</b>");
    expect(email.html).not.toContain("<i>Jane</i>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  test("digest groups by document then link, counts returns, names the top viewer only on Pro", () => {
    const docs = new Map<string, ViewDocInfo>([
      ["d1", DOC],
      ["d2", { docId: "d2", title: "Board deck", pageCount: null }],
    ]);
    const lks = new Map([
      ["shareA", link()],
      ["shareB", link({ shareId: "shareB", label: "Default link", isDefault: true, audience: null })],
      ["shareC", link({ shareId: "shareC", label: "Accel", audience: null })],
    ]);
    const views = [
      view({ at: at(1), viewerName: "Jane Doe", timeSpentMs: 90_000 }),
      view({ at: at(2), botIdHash: "b2", viewerName: "Zed", timeSpentMs: 10_000 }),
      view({ at: at(3), shareId: "shareB", botIdHash: "b3" }),
      view({ at: at(4), docId: "d2", shareId: "shareC", botIdHash: "b4" }),
    ];
    const returns = [ret({ at: at(5) })];

    const pro = vn.composeDigestEmail({ ctx: ctxPro, docs, views, returns, links: lks });
    expect(pro.subject).toBe("4 people opened your documents today");
    expect(pro.text).toContain("1 person came back for another look.");
    expect(pro.text).toContain("USAVX MEMO\n- Sequoia (Roelof): 2 opened, 1 came back · top: Jane Doe (4 of 12 pages · 1m 30s)");
    expect(pro.text).toContain("- Default link: 1 opened");
    expect(pro.text).toContain(`See what they read: ${APP}/doc/d1/metrics\n`);
    expect(pro.text).toContain("Board deck\n- Accel: 1 opened");
    expect(pro.text).toContain(`See what they read: ${APP}/doc/d2/metrics?shareId=shareC`);
    expect(pro.text).toContain("Turn off these emails:");

    const free = vn.composeDigestEmail({ ctx: ctxFree, docs, views, returns, links: lks });
    for (const part of [free.subject, free.text, free.html]) {
      expect(part).not.toContain("Jane");
      expect(part).not.toContain("Zed");
      expect(part).not.toContain("· top:");
    }
    expect(free.text).toContain(vn.PRO_IDENTITY_LINE);
    // Several documents: no one metrics page to show, so the button goes to pricing.
    expect(free.text).toContain(`See who opened it: ${APP}/pricing?from=view_email`);
    expect(free.html).toContain(`href="${APP}/pricing?from=view_email"`);
    expect(pro.text).not.toContain("See who opened it");
  });

  test("digest lists at most DIGEST_MAX_DOCUMENTS documents but counts all of them", () => {
    const n = vn.DIGEST_MAX_DOCUMENTS + 3;
    const docs = new Map<string, ViewDocInfo>();
    const views: NewViewerEvent[] = [];
    for (let i = 0; i < n; i++) {
      docs.set(`d${i}`, { docId: `d${i}`, title: `Doc ${i}`, pageCount: null });
      views.push(view({ docId: `d${i}`, botIdHash: `b${i}`, at: at(i) }));
    }
    const email = vn.composeDigestEmail({ ctx: ctxFree, docs, views, returns: [], links });
    expect(email.subject).toBe(`${n} people opened your documents today`);
    expect(email.text).toContain(`Doc ${vn.DIGEST_MAX_DOCUMENTS - 1}\n`);
    expect(email.text).not.toContain(`Doc ${vn.DIGEST_MAX_DOCUMENTS}\n`);
    expect(email.text).toContain("3 more documents also had activity");
  });

  test("returns-only digest", () => {
    const email = vn.composeDigestEmail({ ctx: ctxFree, docs: new Map([["d1", DOC]]), views: [], returns: [ret()], links });
    expect(email.subject).toBe("1 person came back to your documents today");
    expect(email.text).toContain("- Sequoia (Roelof): 1 came back");
  });
});

/**
 * A `find` stand-in that honours the loader's window, keyset continuation and limit, so paging is
 * exercised for real rather than returning the same rows on every call.
 */
function rangeFind(rows: Array<{ _id: Types.ObjectId; createdDate: Date }>) {
  return (filter: Record<string, any>) => {
    let lim = Number.POSITIVE_INFINITY;
    const q = {
      sort: () => q,
      select: () => q,
      limit: (n: number) => {
        lim = n;
        return q;
      },
      lean: async () =>
        rows
          .filter((r) => {
            const cd = filter.createdDate;
            if (cd && !(r.createdDate > cd.$gt && r.createdDate <= cd.$lte)) return false;
            if (filter.$or) {
              const [a, b] = filter.$or;
              const after =
                r.createdDate > a.createdDate.$gt ||
                (r.createdDate.getTime() === b.createdDate.getTime() && String(r._id) > String(b._id.$gt));
              if (!after) return false;
            }
            return true;
          })
          .sort((x, y) => x.createdDate.getTime() - y.createdDate.getTime() || String(x._id).localeCompare(String(y._id)))
          .slice(0, lim),
    };
    return q;
  };
}

type BulkOp = {
  updateOne: { filter: { userId: Types.ObjectId; key: string }; update: { $max: { lastNotifiedAt?: Date; returnsNotifiedAt?: Date } }; upsert: boolean };
};
function bulkOps(callIndex = 0): BulkOp[] {
  return (cursorBulkWrite.mock.calls[callIndex] as unknown[])[0] as BulkOp[];
}

describe("runViewNotificationsForOrg", () => {
  const ORG = new Types.ObjectId();
  const NOW = at(30);
  const UNTIL = new Date(NOW.getTime() - vn.VIEW_EVENT_SETTLE_MS);
  const U_IMM = new Types.ObjectId().toString();
  const U_DAILY = new Types.ObjectId().toString();
  const U_OFF = new Types.ObjectId().toString();
  const U_NEW = new Types.ObjectId().toString();
  const M_IMM = new Types.ObjectId().toString();
  const D1 = new Types.ObjectId().toString();
  const D2 = new Types.ObjectId().toString();

  function viewRow(docId: string, createdMin: number, extra: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(),
      shareId: "shareA",
      docId: new Types.ObjectId(docId),
      botIdHash: `bot-${createdMin}`,
      createdDate: at(createdMin),
      pagesSeen: [1, 2, 2, 3],
      timeSpentMs: 65_000,
      ...extra,
    };
  }

  type Send = import("@/lib/notifications/viewNotifications").ViewNotificationDeps["send"];
  let sends: Array<Parameters<Send>[0]>;
  let cursorWrites: Array<{ userId: string; lastNotifiedAt?: Date; returnsNotifiedAt?: Date; lastDigestDay?: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sends = [];
    cursorWrites = [];
    getWorkspacePlan.mockResolvedValue("free");
    shareLinkFind.mockReturnValue(chain([{ _id: new Types.ObjectId(), shareId: "shareA", label: "Sequoia", audience: null, isDefault: false, createdDate: at(-1000) }]));
    docFind.mockReturnValue(
      chain([
        { _id: new Types.ObjectId(D1), title: "Doc One", slideNodes: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }] },
        { _id: new Types.ObjectId(D2), title: "Doc Two", slideNodes: [] },
      ]),
    );
    userFind.mockReturnValue(chain([]));
    shareVisitFind.mockReturnValue(chain([]));
    shareVisitAggregate.mockResolvedValue([]);
  });

  function deps(failDocTitle?: string) {
    return {
      send: vi.fn(async (args: Parameters<Send>[0]) => {
        sends.push(args);
        return !(failDocTitle && args.subject.includes(failDocTitle));
      }),
      upsertCursor: vi.fn(async (args: { userId: Types.ObjectId; lastNotifiedAt?: Date; returnsNotifiedAt?: Date; lastDigestDay?: string }) => {
        const write: (typeof cursorWrites)[number] = { userId: String(args.userId), lastNotifiedAt: args.lastNotifiedAt, lastDigestDay: args.lastDigestDay };
        if (args.returnsNotifiedAt) write.returnsNotifiedAt = args.returnsNotifiedAt;
        cursorWrites.push(write);
      }),
    };
  }

  function baseParams(overrides: Record<string, unknown> = {}) {
    return {
      orgId: String(ORG),
      members: [] as Array<{ membershipId: string; userId: string; mode: "off" | "daily" | "immediate" }>,
      recipients: new Map([
        [U_IMM, { email: "imm@x.com" }],
        [U_DAILY, { email: "daily@x.com" }],
        [U_OFF, { email: "off@x.com" }],
        [U_NEW, { email: "new@x.com" }],
      ]),
      now: NOW,
      dryRun: false,
      allowDaily: false,
      todayUtc: "2026-09-16",
      limitEventsPerMember: 20,
      defaultLookbackDays: 7,
      appUrl: APP,
      ...overrides,
    };
  }

  const immediateMember = [{ membershipId: M_IMM, userId: U_IMM, mode: "immediate" as const }];
  const dailyMember = () => [{ membershipId: new Types.ObjectId().toString(), userId: U_DAILY, mode: "daily" as const }];

  test("off, first-seen and no-address members get their cursor set to now and no email", async () => {
    cursorFind.mockReturnValue(
      chain([
        { userId: new Types.ObjectId(U_OFF), lastNotifiedAt: at(0), lastDigestDay: null },
        { userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), lastDigestDay: null },
      ]),
    );
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    const totals = vn.emptyViewNotificationTotals(false);
    const d = deps();
    await vn.runViewNotificationsForOrg(
      baseParams({
        recipients: new Map([
          [U_OFF, { email: "off@x.com" }],
          [U_NEW, { email: "new@x.com" }],
        ]),
        members: [
          { membershipId: new Types.ObjectId().toString(), userId: U_OFF, mode: "off" },
          { membershipId: new Types.ObjectId().toString(), userId: U_NEW, mode: "immediate" },
          { membershipId: M_IMM, userId: U_IMM, mode: "immediate" },
        ],
      }),
      d,
      totals,
    );
    expect(d.send).not.toHaveBeenCalled();
    expect(shareViewFind).not.toHaveBeenCalled();
    expect(cursorBulkWrite).toHaveBeenCalledTimes(1);
    const ops = bulkOps();
    expect(ops.map((o) => String(o.updateOne.filter.userId)).sort()).toEqual([U_OFF, U_NEW, U_IMM].sort());
    for (const o of ops) {
      expect(o.updateOne.filter.key).toBe("share_views");
      // `$max`: an overlapping run can never rewind a cursor.
      expect(o.updateOne.update.$max.lastNotifiedAt).toEqual(NOW);
      // The returns horizon resets too, so turning emails back on cannot flood the digest with returns.
      expect(o.updateOne.update.$max.returnsNotifiedAt).toEqual(NOW);
      expect(o.updateOne.upsert).toBe(true);
    }
    expect(totals.off.members).toBe(1);
    expect(totals.cursorsInitialized).toBe(1);
  });

  test("dry run writes no cursors", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(
      baseParams({
        dryRun: true,
        members: [...immediateMember, { membershipId: new Types.ObjectId().toString(), userId: U_OFF, mode: "off" }],
      }),
      d,
      vn.emptyViewNotificationTotals(false),
    );
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(cursorBulkWrite).not.toHaveBeenCalled();
    expect(d.upsertCursor).not.toHaveBeenCalled();
  });

  test("immediate: one email per document, cursor to the settled instant, working off link", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5), viewRow(D2, 6), viewRow(D1, 7), viewRow(D1, 31)]));
    const totals = vn.emptyViewNotificationTotals(false);
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, totals);

    expect(sends.map((s) => s.subject)).toEqual(['2 people opened "Doc One"', 'Sequoia opened "Doc Two"']);
    expect(sends[0].to).toBe("imm@x.com");
    expect(sends[0].context).toEqual({ orgId: String(ORG), userId: U_IMM, mode: "immediate" });
    expect(sends[0].html).toContain("<!doctype html>");
    expect(sends[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const offUrl = sends[0].text.match(/Turn off these emails: (\S+)/)?.[1] ?? "";
    expect(offUrl.startsWith(`${APP}/api/notifications/views/off?t=`)).toBe(true);
    expect(sends[0].headers["List-Unsubscribe"]).toBe(`<${offUrl}>`);
    const token = new URL(offUrl).searchParams.get("t") ?? "";
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: true, membershipId: M_IMM });

    // Everything up to the settled instant was covered, so the cursor moves there (not past it).
    expect(cursorWrites).toEqual([{ userId: U_IMM, lastNotifiedAt: UNTIL, lastDigestDay: undefined }]);
    expect(totals.immediate).toEqual({ members: 1, emails: 2, events: 3, failed: 0 });
  });

  test("immediate: rows younger than the settle margin wait for the next tick", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 29.5)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, vn.emptyViewNotificationTotals(false));
    expect(d.send).not.toHaveBeenCalled();
    const filter = (shareViewFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(filter.createdDate).toEqual({ $gt: at(0), $lte: UNTIL });
    // The cursor stops at the settled instant, before the unsent row.
    expect(bulkOps()[0].updateOne.update.$max.lastNotifiedAt).toEqual(UNTIL);
    expect(UNTIL < at(29.5)).toBe(true);
  });

  test("immediate: a member switched from daily does not get a burst of old opens", async () => {
    // Cursor from a digest ten hours ago; one open nine hours ago, one ten minutes ago.
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(-600), lastDigestDay: "2026-09-15" }]));
    shareViewFind.mockReturnValue(chain([viewRow(D2, -540), viewRow(D1, 20)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, vn.emptyViewNotificationTotals(false));
    expect(sends.map((s) => s.subject)).toEqual(['Sequoia opened "Doc One"']);
    const filter = (shareViewFind.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(filter.createdDate.$gt).toEqual(new Date(NOW.getTime() - vn.IMMEDIATE_MAX_LOOKBACK_MS));
  });

  test("immediate: a failed document stops the round and holds the cursor before it", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5), viewRow(D2, 6), viewRow(D1, 7)]));
    const totals = vn.emptyViewNotificationTotals(false);
    const d = deps("Doc Two");
    const res = await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, totals);
    // Doc One (5, 7) sent; Doc Two (6) failed.
    expect(sends).toHaveLength(2);
    expect(res.sendFailures).toBe(1);
    expect(cursorWrites).toEqual([{ userId: U_IMM, lastNotifiedAt: new Date(at(6).getTime() - 1), lastDigestDay: undefined }]);
    expect(totals.immediate.failed).toBe(1);
  });

  test("immediate: first document failing writes no cursor past it", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5), viewRow(D2, 6)]));
    const d = deps("Doc One");
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, vn.emptyViewNotificationTotals(false));
    expect(sends).toHaveLength(1);
    expect(cursorWrites).toEqual([{ userId: U_IMM, lastNotifiedAt: new Date(at(5).getTime() - 1), lastDigestDay: undefined }]);
  });

  test("immediate: the per-member cap sends the oldest and resumes after them", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5), viewRow(D1, 6), viewRow(D1, 7)]));
    await vn.runViewNotificationsForOrg(baseParams({ limitEventsPerMember: 2, members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(sends.map((s) => s.subject)).toEqual(['2 people opened "Doc One"']);
    expect(cursorWrites[0].lastNotifiedAt).toEqual(at(6));
  });

  test("Pro names signed-in viewers; Free does not, even with identity on the row", async () => {
    const viewerUser = new Types.ObjectId();
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5, { viewerUserId: viewerUser })]));
    userFind.mockReturnValue(chain([{ _id: viewerUser, name: "Priya Partner" }]));

    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(sends[0].text).not.toContain("Priya");
    expect(sends[0].html).not.toContain("Priya");
    expect(userFind).not.toHaveBeenCalled();

    sends = [];
    getWorkspacePlan.mockResolvedValue("pro");
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(sends[0].text).toContain('Priya Partner opened "Doc One"');
    expect(sends[0].text).toContain("How far: 3 of 3 pages · 1m 5s so far");
  });

  test("a plan lookup failure falls back to Free", async () => {
    getWorkspacePlan.mockRejectedValue(new Error("db down"));
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5, { viewerName: "Jane" })]));
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(sends[0].text).not.toContain("Jane");
    expect(sends[0].text).toContain(vn.PRO_IDENTITY_LINE);
  });

  test("events on deleted/archived documents are not sent, and cursors still move past them", async () => {
    docFind.mockReturnValue(chain([]));
    cursorFind.mockReturnValue(
      chain([
        { userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) },
        { userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: "2026-09-15" },
      ]),
    );
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: [...immediateMember, ...dailyMember()] }), d, vn.emptyViewNotificationTotals(true));
    expect(d.send).not.toHaveBeenCalled();
    const docFilter = (docFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(docFilter.isDeleted).toEqual({ $ne: true });
    expect(docFilter.isArchived).toEqual({ $ne: true });
    // Without this, the same filtered rows would be reloaded every tick and pin the window.
    const ops = bulkOps();
    expect(ops.map((o) => String(o.updateOne.filter.userId)).sort()).toEqual([U_IMM, U_DAILY].sort());
    for (const o of ops) expect(o.updateOne.update.$max.lastNotifiedAt).toEqual(UNTIL);
  });

  test("recipient-only and window filter on the view query", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([]));
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    const filter = (shareViewFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(filter.isOwnerPreview).toEqual({ $ne: true });
    expect(filter.createdDate).toEqual({ $gt: at(0), $lte: UNTIL });
    expect(filter.$or).toBeUndefined();
    expect(String(filter.orgId)).toBe(String(ORG));
  });

  test("loads page through the whole window by (createdDate, _id)", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    const rows = [viewRow(D1, 5), viewRow(D1, 6), viewRow(D1, 6, { botIdHash: "tie" }), viewRow(D1, 8), viewRow(D1, 9)];
    shareViewFind.mockImplementation(rangeFind(rows));
    const totals = vn.emptyViewNotificationTotals(false);
    await vn.runViewNotificationsForOrg(baseParams({ loadPageSize: 2, members: immediateMember }), deps(), totals);
    expect(sends.map((s) => s.subject)).toEqual(['5 people opened "Doc One"']);
    expect(shareViewFind).toHaveBeenCalledTimes(3);
    const second = (shareViewFind.mock.calls[1] as unknown[])[0] as Record<string, any>;
    expect(second.$or[0].createdDate.$gt).toEqual(at(6));
    expect(totals.truncatedLoads).toBe(0);
    expect(cursorWrites[0].lastNotifiedAt).toEqual(UNTIL);
  });

  test("safety cap: a truncated load never lets a cursor pass unloaded events, and is reported", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    // Cap 2 -> 3 rows fetched; the 3rd shares the 2nd's millisecond, so only the 1st is kept.
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5), viewRow(D1, 6), viewRow(D1, 6, { botIdHash: "tie" })]));
    const totals = vn.emptyViewNotificationTotals(false);
    await vn.runViewNotificationsForOrg(baseParams({ loadMaxRows: 2, members: immediateMember }), deps(), totals);
    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toBe('Sequoia opened "Doc One"');
    expect(cursorWrites[0].lastNotifiedAt).toEqual(new Date(at(6).getTime() - 1));
    expect(totals.truncatedLoads).toBe(1);
  });

  test("members without a recipient email are skipped", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ recipients: new Map(), members: immediateMember }), d, vn.emptyViewNotificationTotals(false));
    expect(d.send).not.toHaveBeenCalled();
  });

  test("daily: nothing before the end-of-day gate or after today's digest", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: null }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ members: dailyMember() }), d, vn.emptyViewNotificationTotals(false));
    expect(d.send).not.toHaveBeenCalled();

    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: "2026-09-16" }]));
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: dailyMember() }), d, vn.emptyViewNotificationTotals(true));
    expect(d.send).not.toHaveBeenCalled();
    expect(shareViewFind).not.toHaveBeenCalled();
  });

  test("daily: one digest with new viewers and returns (same-day new tab included); cursor and digest day advance", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: "2026-09-15" }]));
    shareViewFind.mockImplementation((filter: Record<string, unknown>) => {
      if (filter.createdDate) return chain([viewRow(D1, 5), viewRow(D2, 6)]);
      // Return lookup: first views of the visiting readers.
      return chain([
        { shareId: "shareA", botIdHash: "old-reader", createdDate: at(-500) },
        { shareId: "shareA", botIdHash: "bot-5", createdDate: at(5) },
        { shareId: "shareA", botIdHash: "bot-6", createdDate: at(6) },
      ]);
    });
    shareVisitFind.mockReturnValue(
      chain([
        // bot-5's first visit: a first open, not a return.
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D1), botIdHash: "bot-5", createdDate: at(5), pagesSeen: [1] },
        // bot-6 opened at 6 and came back in a new tab at 8, the same day: a return.
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D2), botIdHash: "bot-6", createdDate: at(6), pagesSeen: [1] },
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D2), botIdHash: "bot-6", createdDate: at(8), pagesSeen: [1] },
        // An earlier reader, twice in the window: one return.
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D1), botIdHash: "old-reader", createdDate: at(9), pagesSeen: [1] },
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D1), botIdHash: "old-reader", createdDate: at(12), pagesSeen: [2] },
      ]),
    );
    shareVisitAggregate.mockResolvedValue([
      { _id: { shareId: "shareA", botIdHash: "bot-5" }, first: at(5) },
      { _id: { shareId: "shareA", botIdHash: "bot-6" }, first: at(6) },
      { _id: { shareId: "shareA", botIdHash: "old-reader" }, first: at(-500) },
    ]);
    const totals = vn.emptyViewNotificationTotals(true);
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: dailyMember() }), d, totals);
    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toBe("2 people opened your documents today");
    expect(sends[0].text).toContain("Doc One\n- Sequoia: 1 opened, 1 came back");
    expect(sends[0].text).toContain("Doc Two\n- Sequoia: 1 opened, 1 came back");
    expect(sends[0].context.mode).toBe("daily");
    expect(cursorWrites).toEqual([{ userId: U_DAILY, lastNotifiedAt: UNTIL, returnsNotifiedAt: UNTIL, lastDigestDay: "2026-09-16" }]);
    expect(totals.daily).toMatchObject({ members: 1, emails: 1, events: 2, returns: 2, failed: 0 });
    const visitFilter = (shareVisitFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(visitFilter.isOwnerPreview).toEqual({ $ne: true });
    // Server-side createdDate, never the browser's startedAt.
    expect(visitFilter.createdDate).toEqual({ $gt: at(0), $lte: UNTIL });
    expect(visitFilter.startedAt).toBeUndefined();
  });

  test("daily: counts cover the whole window, not the per-member event cap", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(-1200), lastDigestDay: "2026-09-15" }]));
    const rows = Array.from({ length: 60 }, (_, i) => viewRow(D1, -1000 + i * 10));
    shareViewFind.mockImplementation((filter: Record<string, unknown>) => (filter.createdDate ? rangeFind(rows)(filter) : chain([])));
    const totals = vn.emptyViewNotificationTotals(true);
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, limitEventsPerMember: 20, loadPageSize: 25, members: dailyMember() }), deps(), totals);
    expect(sends.map((s) => s.subject)).toEqual(["60 people opened your documents today"]);
    expect(sends[0].text).toContain("- Sequoia: 60 opened");
    expect(totals.daily.events).toBe(60);
    expect(cursorWrites).toEqual([{ userId: U_DAILY, lastNotifiedAt: UNTIL, returnsNotifiedAt: UNTIL, lastDigestDay: "2026-09-16" }]);
  });

  test("daily: a window longer than a day names its start date", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(-3 * 24 * 60), lastDigestDay: "2026-09-13" }]));
    shareViewFind.mockImplementation((filter: Record<string, unknown>) => (filter.createdDate ? chain([viewRow(D1, 5)]) : chain([])));
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: dailyMember() }), deps(), vn.emptyViewNotificationTotals(true));
    expect(sends[0].subject).toBe("1 person opened your documents since Sep 13");
  });

  test("daily: a load cut by the safety cap leaves today's digest open for the remainder", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: "2026-09-15" }]));
    shareViewFind.mockImplementation((filter: Record<string, unknown>) =>
      filter.createdDate ? chain([viewRow(D1, 5), viewRow(D1, 6), viewRow(D1, 7)]) : chain([]),
    );
    const totals = vn.emptyViewNotificationTotals(true);
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, loadMaxRows: 2, members: dailyMember() }), deps(), totals);
    expect(sends.map((s) => s.subject)).toEqual(["2 people opened your documents today"]);
    expect(cursorWrites).toEqual([
      { userId: U_DAILY, lastNotifiedAt: new Date(at(7).getTime() - 1), returnsNotifiedAt: new Date(at(7).getTime() - 1), lastDigestDay: undefined },
    ]);
    expect(totals.truncatedLoads).toBe(1);
  });

  test("daily: a failed digest leaves the cursor and the digest day alone", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: at(0), lastDigestDay: null }]));
    shareViewFind.mockImplementation((filter: Record<string, unknown>) => (filter.createdDate ? chain([viewRow(D1, 5)]) : chain([])));
    const d = {
      send: vi.fn(async () => false),
      upsertCursor: vi.fn(async () => undefined),
    };
    const totals = vn.emptyViewNotificationTotals(true);
    const res = await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: dailyMember() }), d, totals);
    expect(res.sendFailures).toBe(1);
    expect(totals.daily.failed).toBe(1);
    expect(d.upsertCursor).not.toHaveBeenCalled();
    expect(cursorBulkWrite).not.toHaveBeenCalled();
  });

  /** A reader who first opened long ago and came back at `createdMin` (a return). */
  function returnVisitRows(createdMin: number) {
    shareViewFind.mockImplementation((filter: Record<string, unknown>) =>
      filter.createdDate ? chain([]) : chain([{ shareId: "shareA", botIdHash: "old-reader", createdDate: at(-500) }]),
    );
    shareVisitFind.mockReturnValue(
      chain([
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D1), botIdHash: "old-reader", createdDate: at(createdMin), pagesSeen: [1] },
      ]),
    );
    shareVisitAggregate.mockResolvedValue([{ _id: { shareId: "shareA", botIdHash: "old-reader" }, first: at(-500) }]);
  }

  test("immediate ticks never move the returns horizon (S3: a return while on immediate is not lost)", async () => {
    returnVisitRows(10);
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(0) }]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), d, vn.emptyViewNotificationTotals(false));
    expect(d.send).not.toHaveBeenCalled();
    // Not the digest tick: visits are not loaded and only the new-viewer horizon moves.
    expect(shareVisitFind).not.toHaveBeenCalled();
    const ops = bulkOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.update.$max).toEqual({ lastNotifiedAt: UNTIL });

    // The member switches to daily. The digest reads returns from the untouched returns horizon.
    vi.clearAllMocks();
    sends = [];
    cursorWrites = [];
    returnVisitRows(10);
    docFind.mockReturnValue(chain([{ _id: new Types.ObjectId(D1), title: "Doc One", slideNodes: [] }]));
    shareLinkFind.mockReturnValue(chain([{ _id: new Types.ObjectId(), shareId: "shareA", label: null, audience: null, isDefault: true, createdDate: at(-1000) }]));
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_DAILY), lastNotifiedAt: UNTIL, returnsNotifiedAt: at(0), lastDigestDay: "2026-09-15" }]));
    const totals = vn.emptyViewNotificationTotals(true);
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: dailyMember() }), deps(), totals);
    expect(sends.map((s) => s.subject)).toEqual(["1 person came back to your documents today"]);
    expect(sends[0].text).toContain("Doc One\n- Default link: 1 came back");
    const visitFilter = (shareVisitFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(visitFilter.createdDate).toEqual({ $gt: at(0), $lte: UNTIL });
    expect(totals.daily).toMatchObject({ emails: 1, events: 0, returns: 1 });
    // Only the returns horizon had anything to cover; the new-viewer cursor is already at UNTIL.
    expect(cursorWrites).toEqual([{ userId: U_DAILY, returnsNotifiedAt: UNTIL, lastDigestDay: "2026-09-16" }]);
  });

  test("immediate: at the end-of-day tick the member also gets a returns-only digest", async () => {
    shareViewFind.mockImplementation((filter: Record<string, unknown>) =>
      filter.createdDate ? chain([viewRow(D1, 20)]) : chain([{ shareId: "shareA", botIdHash: "old-reader", createdDate: at(-500) }]),
    );
    shareVisitFind.mockReturnValue(
      chain([
        { _id: new Types.ObjectId(), shareId: "shareA", docId: new Types.ObjectId(D1), botIdHash: "old-reader", createdDate: at(-120), pagesSeen: [1] },
      ]),
    );
    shareVisitAggregate.mockResolvedValue([{ _id: { shareId: "shareA", botIdHash: "old-reader" }, first: at(-500) }]);
    // Old cursor written before `returnsNotifiedAt` existed: returns fall back to `lastNotifiedAt`.
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(-180), lastDigestDay: null }]));
    const totals = vn.emptyViewNotificationTotals(true);
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: immediateMember }), deps(), totals);

    expect(sends.map((s) => [s.subject, s.context.mode])).toEqual([
      ['Sequoia opened "Doc One"', "immediate"],
      ["1 person came back to your documents today", "daily"],
    ]);
    // The digest carries no new viewers: those went out immediately.
    expect(sends[1].text).toContain("Doc One\n- Sequoia: 1 came back\n");
    expect(sends[1].text).not.toMatch(/\d+ opened/);
    // New-viewer window is still capped at an hour; the returns window is the digest window.
    const viewFilter = (shareViewFind.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(viewFilter.createdDate.$gt).toEqual(new Date(NOW.getTime() - vn.IMMEDIATE_MAX_LOOKBACK_MS));
    const visitFilter = (shareVisitFind.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(visitFilter.createdDate.$gt).toEqual(at(-180));
    // Two writes, one per horizon; the digest write never touches the new-viewer cursor.
    // The immediate write also pins the older cursor's returns horizon at its fallback value.
    expect(cursorWrites).toEqual([
      { userId: U_IMM, lastNotifiedAt: UNTIL, returnsNotifiedAt: at(-180), lastDigestDay: undefined },
      { userId: U_IMM, returnsNotifiedAt: UNTIL, lastDigestDay: "2026-09-16" },
    ]);
    expect(totals.immediate).toMatchObject({ emails: 1, events: 1 });
    expect(totals.daily).toMatchObject({ emails: 1, events: 0, returns: 1 });

    // Same UTC day again: no second digest.
    vi.clearAllMocks();
    sends = [];
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: UNTIL, returnsNotifiedAt: UNTIL, lastDigestDay: "2026-09-16" }]));
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: immediateMember }), deps(), vn.emptyViewNotificationTotals(true));
    expect(shareVisitFind).not.toHaveBeenCalled();
    expect(sends.filter((s) => s.context.mode === "daily")).toHaveLength(0);
  });

  test("older cursor without returnsNotifiedAt: immediate ticks pin the returns horizon instead of following lastNotifiedAt (S3 round 2)", async () => {
    // Tick 1, not the digest tick, nothing new: only a bulk advance. The return at 10 is not loaded yet.
    returnVisitRows(10);
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), lastDigestDay: null }]));
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(bulkOps()[0].updateOne.update.$max).toEqual({ lastNotifiedAt: UNTIL, returnsNotifiedAt: at(0) });

    // Tick 1b, a new viewer is emailed: the upsert carries the seed too.
    vi.clearAllMocks();
    sends = [];
    cursorWrites = [];
    shareViewFind.mockImplementation((filter: Record<string, unknown>) =>
      filter.createdDate ? chain([viewRow(D1, 20)]) : chain([]),
    );
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), lastDigestDay: null }]));
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(sends).toHaveLength(1);
    expect(cursorWrites).toEqual([{ userId: U_IMM, lastNotifiedAt: UNTIL, returnsNotifiedAt: at(0), lastDigestDay: undefined }]);

    // Tick 2, the digest tick, from the cursor tick 1 left: the return at 10 is still reported.
    vi.clearAllMocks();
    sends = [];
    cursorWrites = [];
    returnVisitRows(10);
    docFind.mockReturnValue(chain([{ _id: new Types.ObjectId(D1), title: "Doc One", slideNodes: [] }]));
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: UNTIL, returnsNotifiedAt: at(0), lastDigestDay: null }]));
    const totals = vn.emptyViewNotificationTotals(true);
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: immediateMember }), deps(), totals);
    expect(sends.map((s) => s.context.mode)).toEqual(["daily"]);
    expect(totals.daily).toMatchObject({ emails: 1, returns: 1 });
    const visitFilter = (shareVisitFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(visitFilter.createdDate).toEqual({ $gt: at(0), $lte: UNTIL });
  });

  test("cursor that already has returnsNotifiedAt: immediate advances never write it", async () => {
    shareViewFind.mockImplementation((filter: Record<string, unknown>) =>
      filter.createdDate ? chain([viewRow(D1, 20)]) : chain([]),
    );
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(-60), lastDigestDay: null }]));
    await vn.runViewNotificationsForOrg(baseParams({ members: immediateMember }), deps(), vn.emptyViewNotificationTotals(false));
    expect(cursorWrites).toEqual([{ userId: U_IMM, lastNotifiedAt: UNTIL, lastDigestDay: undefined }]);
  });

  test("immediate: no returns at the digest tick moves the returns horizon without an email", async () => {
    shareViewFind.mockReturnValue(chain([]));
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0), returnsNotifiedAt: at(-60) }]));
    const d = deps();
    await vn.runViewNotificationsForOrg(baseParams({ allowDaily: true, members: immediateMember }), d, vn.emptyViewNotificationTotals(true));
    expect(d.send).not.toHaveBeenCalled();
    expect(bulkOps()).toHaveLength(1);
    expect(bulkOps()[0].updateOne.update.$max).toEqual({ lastNotifiedAt: UNTIL, returnsNotifiedAt: UNTIL });
  });

  test("no absolute app URL: throws before loading or sending, so nothing is consumed", async () => {
    cursorFind.mockReturnValue(chain([{ userId: new Types.ObjectId(U_IMM), lastNotifiedAt: at(0) }]));
    shareViewFind.mockReturnValue(chain([viewRow(D1, 5)]));
    for (const appUrl of ["", "/relative", "lnkdrp.com"]) {
      vi.clearAllMocks();
      const d = deps();
      await expect(
        vn.runViewNotificationsForOrg(baseParams({ appUrl, members: immediateMember }), d, vn.emptyViewNotificationTotals(false)),
      ).rejects.toThrow(/absolute site URL/);
      expect(shareViewFind).not.toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
      expect(d.upsertCursor).not.toHaveBeenCalled();
    }
  });
});

describe("email design review (headers, preheader, Outlook, copy)", () => {
  const ctxFree = { appUrl: APP, offUrl: `${APP}/api/notifications/views/off?t=tok`, plan: "free" as const };
  const ctxPro = { ...ctxFree, plan: "pro" as const };
  const links = new Map([["shareA", link()]]);
  const dflt = new Map([["shareA", link({ label: "Default link", isDefault: true, audience: null })]]);

  /** The hidden preheader's text (before the filler), or null when there is none. */
  function preheaderOf(html: string): string | null {
    const m = html.match(/<body[^>]*><div style="display:none;[^"]*">([^&<]*)/);
    return m ? m[1] : null;
  }

  test("every view email carries RFC 8058 one-click unsubscribe headers, on Free and Pro", () => {
    for (const ctx of [ctxFree, ctxPro]) {
      const imm = vn.composeImmediateEmail({ ctx, doc: DOC, events: [view({ viewerName: "Jane Doe" })], links });
      const dig = vn.composeDigestEmail({ ctx, docs: new Map([["d1", DOC]]), views: [view()], returns: [], links });
      for (const email of [imm, dig]) {
        expect(email.headers).toEqual({
          "List-Unsubscribe": `<${ctx.offUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        });
      }
    }
    expect(vn.viewEmailHeaders("https://x.test/off?t=a")["List-Unsubscribe"]).toBe("<https://x.test/off?t=a>");
  });

  test("hidden preheader is the first body element: link + how far on Pro, link + when on Free", () => {
    const ev = view({ viewerName: "Jane Doe", viewerEmail: "jane@fund.com" });
    const pro = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [ev], links });
    expect(pro.html).toMatch(/<body[^>]*><div style="display:none;[^"]*mso-hide:all;/);
    expect(preheaderOf(pro.html)).toBe("Jane Doe · Sequoia · 4 of 12 pages · 3m 20s");

    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [ev], links });
    const ph = preheaderOf(free.html) ?? "";
    expect(ph).toBe("Sequoia · Sep 16, 2026, 09:01 UTC");
    for (const leak of ["Jane", "jane@fund.com", "pages", "3m 20s"]) expect(ph).not.toContain(leak);
  });

  test("Free preheader and headers never carry identity, even for a batch", () => {
    const events = [
      view({ viewerName: "Jane Doe", viewerEmail: "jane@fund.com" }),
      view({ botIdHash: "b2", at: at(3), viewerUserId: new Types.ObjectId().toString(), viewerUserName: "Bob Account" }),
    ];
    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events, links });
    const ph = preheaderOf(free.html) ?? "";
    expect(ph).toBe("Sequoia · 2 people · latest Sep 16, 2026, 09:03 UTC");
    const headerText = JSON.stringify(free.headers);
    for (const leak of ["Jane", "jane@fund.com", "Bob", "pages", "3m 20s"]) {
      expect(ph).not.toContain(leak);
      expect(headerText).not.toContain(leak);
    }
  });

  test("digest preheader is counts only", () => {
    const docs = new Map<string, ViewDocInfo>([["d1", DOC], ["d2", { docId: "d2", title: "Board deck", pageCount: null }]]);
    const email = vn.composeDigestEmail({
      ctx: ctxPro,
      docs,
      views: [view({ viewerName: "Jane Doe" }), view({ docId: "d2", botIdHash: "b2" })],
      returns: [ret({ at: at(5) })],
      links,
    });
    expect(preheaderOf(email.html)).toBe("2 opened · 1 came back · 2 documents");
    expect(vn.digestPreheader(0, 1, 1)).toBe("1 came back · 1 document");
  });

  test("Outlook-safe card and button, light-only color scheme, wordmark", () => {
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view()], links });
    expect(email.html).toContain('<meta name="color-scheme" content="light only">');
    expect(email.html).toContain('<meta name="supported-color-schemes" content="light only">');
    expect(email.html).toContain('<!--[if mso]><table role="presentation" width="560" align="center"');
    expect(email.html).toContain("<!--[if mso]></td></tr></table><![endif]-->");
    // Background and padding on the cell, the link inside it.
    expect(email.html).toMatch(
      /<td align="center" bgcolor="#18181b" style="[^"]*padding:10px 16px;[^"]*"><a href="https:\/\/app\.example\.com\/doc\/d1\/metrics\/viewer\/a_bot1" style="[^"]*color:#ffffff;/,
    );
    expect(email.html).not.toMatch(/<a [^>]*padding:10px 16px/);
    expect(email.html).toMatch(/<td style="[^"]*font-size:13px;[^"]*color:#71717a;[^"]*">LinkDrop<\/td>/);
    // No stylesheet, no classes: everything inline.
    expect(email.html).not.toContain("<style");
    expect(email.html).not.toContain("class=");
  });

  test("a long unbroken title wraps instead of widening the card", () => {
    const title = "USAvionix_One_Pager_final_v3_".repeat(5).slice(0, 120);
    const email = vn.composeImmediateEmail({ ctx: ctxPro, doc: { ...DOC, title }, events: [view()], links });
    const h1 = email.html.match(/<h1 style="([^"]*)">/)?.[1] ?? "";
    expect(h1).toContain("word-break:break-word;");
    expect(h1).toContain("overflow-wrap:anywhere;");
    const valueCell = email.html.match(/<td style="padding:2px 0;[^"]*">Sequoia<\/td>/)?.[0] ?? "";
    expect(valueCell).toContain("overflow-wrap:anywhere;");
  });

  test("footer: new reason line, 13px, inline-block tap targets, preferences anchor", () => {
    const email = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [view()], links });
    expect(vn.VIEW_EMAIL_FOOTER_REASON).toBe("You get this because someone opened a link to a document in your workspace.");
    expect(email.text).toContain(vn.VIEW_EMAIL_FOOTER_REASON);
    expect(email.html).toContain(`href="${APP}/dashboard?tab=notifications#email-preferences" style="display:inline-block;padding:4px 0;`);
    expect(email.html).toContain(`href="${ctxFree.offUrl}" style="display:inline-block;padding:4px 0;`);
    expect(email.html).not.toContain("font-size:12px");
  });

  test("the preferences anchor exists on the email preferences block", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/components/notifications/NotificationPreferences.tsx"), "utf8");
    expect(src).toContain(`id="${vn.VIEW_EMAIL_PREFERENCES_ANCHOR}"`);
    // The route used to repeat the path as a literal, and the two drifted the moment the settings
    // moved tabs. It imports the constant now, so agreement is structural rather than asserted.
    const route = readFileSync(path.resolve(__dirname, "../../src/app/api/notifications/views/off/route.ts"), "utf8");
    expect(route).toContain("VIEW_EMAIL_PREFERENCES_PATH");
    expect(route).not.toMatch(/const PREFERENCES_PATH = "/);
  });

  test("the default link reads the same as in the links UI", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/lib/share/links.ts"), "utf8");
    const uiLabel = src.match(/export const DEFAULT_LINK_LABEL = "([^"]+)"/)?.[1];
    expect(uiLabel).toBeTruthy();
    expect(vn.linkDisplayName(link({ isDefault: true }))).toBe(uiLabel);
  });

  test("no 'Who' row without a real name, and never 'Who: Someone'", () => {
    const anon = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view()], links: dflt });
    expect(anon.text).not.toContain("Who:");
    expect(anon.html).not.toContain(">Who<");
    expect(anon.text.split("\n")[0]).toBe('Someone opened "USAVX MEMO"');
    const labelled = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view()], links });
    expect(labelled.text).not.toContain("Who:");
    const named = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events: [view({ viewerEmail: "jane@fund.com" })], links });
    expect(named.text).toContain("Who: jane@fund.com");
    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events: [view({ viewerName: "Jane Doe" })], links });
    expect(free.text).not.toContain("Who:");
  });

  test("batch on one link: Link once, each viewer as '<time> · <how far>' (Free: time only), no 'Viewer N'", () => {
    const events = [
      view({ at: at(1), pagesSeen: 1, timeSpentMs: 15_000 }),
      view({ at: at(2), botIdHash: "b2", pagesSeen: 0, timeSpentMs: 0 }),
      view({ at: at(3), botIdHash: "b3", viewerName: "Jane Doe" }),
    ];
    const pro = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events, links: dflt });
    expect(pro.subject).toBe('3 people opened "USAVX MEMO"');
    expect(pro.text).toContain(
      [
        '3 people opened "USAVX MEMO"',
        "",
        "Link: Default link",
        "",
        "09:01 UTC · 1 of 12 pages · 15s",
        "09:02 UTC · Just opened",
        "Jane Doe · 09:03 UTC · 4 of 12 pages · 3m 20s",
        "",
        `See what they read: ${APP}/doc/d1/metrics?shareId=shareA`,
      ].join("\n"),
    );
    expect(pro.text.match(/Link: /g)?.length).toBe(1);
    expect(pro.text).not.toMatch(/Viewer \d/);
    expect(pro.text).not.toContain("First open");

    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events, links: dflt });
    expect(free.text).toContain(["Link: Default link", "", "09:01 UTC", "09:02 UTC", "09:03 UTC", "", "See what they read:"].join("\n"));
    for (const part of [free.text, free.html]) {
      expect(part).not.toMatch(/Viewer \d/);
      expect(part).not.toContain("Jane");
      expect(part).not.toContain("15s");
      expect(part).not.toContain("of 12 pages");
    }
  });

  test("batch across links names the link per viewer and never says 'Viewer N'", () => {
    const multi = new Map([
      ["shareA", link({ label: "Default link", isDefault: true, audience: null })],
      ["shareB", link({ shareId: "shareB", label: "a16z", audience: "Partners" })],
    ]);
    const events = [view({ at: at(1) }), view({ at: at(2), shareId: "shareB", botIdHash: "b2" })];
    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events, links: multi });
    expect(free.text).toContain("Default link · 09:01 UTC");
    expect(free.text).toContain("a16z · 09:02 UTC\nAudience: Partners");
    expect(free.text).not.toMatch(/Viewer \d/);
    const pro = vn.composeImmediateEmail({ ctx: ctxPro, doc: DOC, events, links: multi });
    expect(pro.text).toContain("How far: 4 of 12 pages · 3m 20s");
  });

  test("batch spanning two UTC days shows full dates per viewer", () => {
    const events = [
      view({ at: new Date("2026-09-16T23:59:00Z") }),
      view({ at: new Date("2026-09-17T00:01:00Z"), botIdHash: "b2" }),
    ];
    const free = vn.composeImmediateEmail({ ctx: ctxFree, doc: DOC, events, links });
    expect(free.text).toContain("Sep 16, 2026, 23:59 UTC\nSep 17, 2026, 00:01 UTC");
  });
});
