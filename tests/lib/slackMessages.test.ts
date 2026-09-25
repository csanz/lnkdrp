/**
 * What the four Slack messages say, and that a Free workspace never learns who the reader was
 * (docs/prds/lnkdrp-slack.md, decisions 6 and 8, verification 8 and 12).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  pro: false,
  doc: { title: "Q3 Deck <draft>", receivedViaRequestProjectId: null as unknown } as Record<string, unknown> | null,
  brief: null as Record<string, unknown> | null,
  change: null as Record<string, unknown> | null,
}));

const lean = (v: unknown) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: () => lean(state.doc) } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: () => lean(state.pro ? { status: "active", kind: "pro" } : null) } }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { findOne: () => lean({ label: "Investors", audience: null, isDefault: false }) } }));
vi.mock("@/lib/models/VisitBrief", () => ({ VisitBriefModel: { findOne: () => lean(state.brief) } }));
vi.mock("@/lib/models/DocChange", () => ({ DocChangeModel: { findOne: () => lean(state.change) } }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { findOne: () => lean({ originalFileName: "nda-signed.pdf" }) } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findOne: () => lean({ name: "Acme NDA" }) } }));
vi.mock("@/lib/notifications/sendNotificationEmails", () => ({ publicBaseUrl: () => "https://www.lnkdrp.com" }));

import { renderSlackEvent } from "@/lib/slack/messages";
import type { SlackOutbox } from "@/lib/models/SlackOutbox";

const orgId = new Types.ObjectId();
const docId = new Types.ObjectId();
const row = (kind: SlackOutbox["kind"], event: Partial<SlackOutbox["event"]>): SlackOutbox =>
  ({ _id: new Types.ObjectId(), orgId, connectionId: new Types.ObjectId(), kind, dedupeKey: "k", event: { docId, ...event }, occurredAt: new Date(), status: "pending", attempts: 0 }) as unknown as SlackOutbox;

const flat = (m: { blocks?: unknown[] } | null) => JSON.stringify(m?.blocks ?? []);

beforeEach(() => {
  state.pro = false;
  state.doc = { title: "Q3 Deck <draft>", receivedViaRequestProjectId: null };
  state.brief = null;
  state.change = null;
});

describe("views", () => {
  test("on Free the reader is Someone, even when the row knows the name", async () => {
    const m = await renderSlackEvent(row("views", { shareId: "s1", viewerName: "Dana Reyes", viewerEmail: "dana@acme.com" }));
    expect(m?.text).toBe("Someone opened Q3 Deck <draft> via Investors.");
    expect(m?.text).not.toContain("Dana");
    expect(flat(m)).not.toContain("dana@acme.com");
  });

  test("on Pro the name shows, the title is escaped, and the link points at the document", async () => {
    state.pro = true;
    const m = await renderSlackEvent(row("views", { shareId: "s1", viewerName: "Dana Reyes" }));
    expect(m?.text).toContain("Dana Reyes opened");
    expect(flat(m)).toContain("Q3 Deck &lt;draft&gt;");
    expect(flat(m)).toContain(`https://www.lnkdrp.com/doc/${String(docId)}`);
    expect(flat(m)).not.toContain("<@");
  });

  test("a deleted document renders nothing", async () => {
    state.doc = null;
    expect(await renderSlackEvent(row("views", { shareId: "s1" }))).toBeNull();
  });
});

describe("briefs", () => {
  test("a briefed visit carries the headline and links to the visit", async () => {
    state.pro = true;
    state.brief = { status: "briefed", brief: { headline: "Skipped pricing, lingered on the team slide", body: "Two minutes on page 4." }, docId, botIdHash: "abc", viewerName: "Dana", stats: { timeSpentMs: 125_000, pagesSeen: 4 } };
    const m = await renderSlackEvent(row("briefs", { visitBriefId: new Types.ObjectId(), viewerKey: "abc" }));
    expect(m?.text).toContain("Dana finished reading Q3 Deck <draft>: Skipped pricing");
    expect(flat(m)).toMatch(new RegExp(`/doc/${String(docId)}/metrics/viewer/[^"|]*abc`));
    expect(flat(m)).toContain("4 pages");
  });

  test("a recap (no model output) still posts a plain line; on Free the reader is Someone", async () => {
    state.brief = { status: "recap", brief: null, docId, botIdHash: "abc", viewerName: "Dana", stats: { timeSpentMs: 9_000, pagesSeen: 1 } };
    const m = await renderSlackEvent(row("briefs", { visitBriefId: new Types.ObjectId() }));
    expect(m?.text).toMatch(/^Someone finished reading Q3 Deck <draft>/);
  });

  test("a purged brief renders nothing", async () => {
    expect(await renderSlackEvent(row("briefs", { visitBriefId: new Types.ObjectId() }))).toBeNull();
  });
});

describe("docUpdates and requests", () => {
  test("a replacement names the version and the change summary", async () => {
    state.change = { diff: { summary: "Pricing page updated; new slide on hiring." }, toVersion: 3 };
    const m = await renderSlackEvent(row("docUpdates", { uploadId: new Types.ObjectId(), version: 3 }));
    expect(m?.text).toBe("Q3 Deck <draft> was replaced (v3). Pricing page updated; new slide on hiring.");
    expect(flat(m)).toContain("/history");
  });

  test("a document added to a project names the document and the room, and links both", async () => {
    state.doc = { title: "Acme cap table" };
    const m = await renderSlackEvent(row("docs", { projectId: new Types.ObjectId() }));
    expect(m?.text).toBe("Acme cap table was added to Acme NDA.");
    expect(flat(m)).toContain("/doc/");
    expect(flat(m)).toContain("/project/");
  });

  test("a received file names the file and the inbox", async () => {
    state.doc = { title: "nda-signed", receivedViaRequestProjectId: new Types.ObjectId() };
    const m = await renderSlackEvent(row("requests", { uploadId: new Types.ObjectId() }));
    expect(m?.text).toBe("nda-signed.pdf was received in Acme NDA.");
  });
});
