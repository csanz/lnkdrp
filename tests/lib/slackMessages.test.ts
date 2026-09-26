/**
 * What the four Slack messages say, and that a Free workspace never learns who the reader was
 * (docs/prds/lnkdrp-slack.md, decisions 6 and 8, verification 8 and 12).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  pro: false,
  shareViews: [] as Array<Record<string, unknown>>,
  arrivals: [] as Array<Record<string, unknown>>,
  doc: { title: "Q3 Deck <draft>", receivedViaRequestProjectId: null as unknown } as Record<string, unknown> | null,
  brief: null as Record<string, unknown> | null,
  change: null as Record<string, unknown> | null,
  link: { label: "Investors", audience: null as string | null, isDefault: false } as Record<string, unknown> | null,
  project: { name: "Acme NDA", isRequest: false } as Record<string, unknown> | null,
}));

const lean = (v: unknown) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: () => lean(state.doc) } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: () => lean(state.pro ? { status: "active", kind: "pro" } : null) } }));
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: { find: () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => state.shareViews }) }) }) }) },
}));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: { find: () => ({ select: () => ({ limit: () => ({ lean: async () => state.arrivals }) }) }) },
}));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { findOne: () => lean(state.link) } }));
vi.mock("@/lib/models/VisitBrief", () => ({ VisitBriefModel: { findOne: () => lean(state.brief) } }));
vi.mock("@/lib/models/DocChange", () => ({ DocChangeModel: { findOne: () => lean(state.change) } }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { findOne: () => lean({ originalFileName: "nda-signed.pdf" }) } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findOne: () => lean(state.project) } }));
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
  state.shareViews = [];
  state.arrivals = [];
  state.doc = { title: "Q3 Deck <draft>", receivedViaRequestProjectId: null };
  state.brief = null;
  state.change = null;
  state.link = { label: "Investors", audience: null, isDefault: false };
  state.project = { name: "Acme NDA", isRequest: false };
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

  test("a data-room reader who introduced themselves on the landing page is named, even though the open event carries no name", async () => {
    state.pro = true;
    // The landing-page introduction lives on the arrival row, not on any share view.
    state.arrivals = [{ viewerName: "Elena Ruiz", viewerEmailSnapshot: "elena@a16z.example" }];
    const m = await renderSlackEvent(row("views", { shareId: "p1", viewerKey: "abc.6ab6c0a87102af9d9d260502", viewerName: null, viewerEmail: null }));
    expect(m?.text).toBe("Elena Ruiz opened Q3 Deck <draft> via Investors.");
    state.arrivals = [];
    state.shareViews = [{ viewerName: "Elena Ruiz" }];
    expect((await renderSlackEvent(row("views", { shareId: "p1", viewerKey: "abc" })))?.text).toMatch(/^Elena Ruiz opened/);
    state.pro = false;
    expect((await renderSlackEvent(row("views", { shareId: "p1", viewerKey: "abc" })))?.text).toMatch(/^Someone opened/);
  });

  test("an introduction posts as its own line, on Free too", async () => {
    const m = await renderSlackEvent(row("views", { shareId: "p1", viewerKey: "abc", viewerName: "Elena Ruiz", viewerEmail: "elena@a16z.example", introduced: true, docId: null }));
    expect(m?.text).toBe("Elena Ruiz introduced themselves on a document via Investors. elena@a16z.example");
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

  test("a change of replaced still renders the replacement line", async () => {
    state.change = { diff: { summary: "Pricing page updated." }, toVersion: 2 };
    const m = await renderSlackEvent(row("docUpdates", { uploadId: new Types.ObjectId(), version: 2, change: "replaced" }));
    expect(m?.text).toBe("Q3 Deck <draft> was replaced (v2). Pricing page updated.");
    expect(flat(m)).toContain("/history");
  });

  test("a new document names the title and the page count, and links to the document", async () => {
    state.doc = { title: "Q3 Deck <draft>", slideNodes: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }] };
    const m = await renderSlackEvent(row("docs", { change: "created" }));
    expect(m?.text).toBe("Q3 Deck <draft> was added.");
    expect(flat(m)).toContain("Q3 Deck &lt;draft&gt;");
    expect(flat(m)).toContain("3 pages");
    expect(flat(m)).toContain(`https://www.lnkdrp.com/doc/${String(docId)}`);
    expect(flat(m)).not.toContain("<@");
  });

  test("a new document link names the link label and the title, with the audience", async () => {
    state.link = { label: "Series A <VCs>", audience: "Sequoia", isDefault: false };
    const m = await renderSlackEvent(row("docUpdates", { change: "link_created", shareId: "s9", linkId: new Types.ObjectId() }));
    expect(m?.text).toBe("New link Series A <VCs> for Q3 Deck <draft>.");
    expect(flat(m)).toContain("Series A &lt;VCs&gt;");
    expect(flat(m)).toContain("for Sequoia");
    expect(flat(m)).toContain(`https://www.lnkdrp.com/doc/${String(docId)}/links`);
    expect(flat(m)).not.toContain("<@");
  });

  test("a new data-room link names the project and links to the room", async () => {
    const projectId = new Types.ObjectId();
    const m = await renderSlackEvent(row("docUpdates", { change: "link_created", shareId: "p9", docId: null, projectId }));
    expect(m?.text).toBe("New link Investors for Acme NDA.");
    expect(flat(m)).toContain(`https://www.lnkdrp.com/project/${String(projectId)}`);
    expect(flat(m)).toContain("open the data room");
  });

  test("a new link whose row is gone renders nothing", async () => {
    state.link = null;
    expect(await renderSlackEvent(row("docUpdates", { change: "link_created", shareId: "s9" }))).toBeNull();
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

/**
 * The channel had no hierarchy: a recipient opening a document and a teammate filing one were the
 * same weight, so the event the product exists for was as easy to scroll past as an upload. The
 * colour is the whole fix, and the line it draws is the PRD's own — what a recipient did against
 * what the workspace did to its own documents.
 */
describe("hierarchy", () => {
  const RECIPIENT = "#0f9f6e";
  const WORKSPACE = "#6b7280";

  test("what a recipient did carries the accent; what the workspace did recedes", async () => {
    state.pro = true;
    state.brief = { status: "recap", stats: { timeSpentMs: 30_000, pagesSeen: 2 }, docId };
    state.change = { diff: { summary: "New pricing" }, toVersion: 2 };

    const recipient = [
      await renderSlackEvent(row("views", { viewerName: "Ana" })),
      await renderSlackEvent(row("views", { introduced: true, viewerName: "Ana", projectId: new Types.ObjectId() })),
      await renderSlackEvent(row("briefs", { visitBriefId: new Types.ObjectId() })),
      // A file arriving in a request inbox is someone outside acting, not housekeeping.
      await renderSlackEvent(row("requests", { uploadId: new Types.ObjectId() })),
    ];
    const workspace = [
      await renderSlackEvent(row("docs", { change: "created" })),
      await renderSlackEvent(row("docs", { projectId: new Types.ObjectId() })),
      await renderSlackEvent(row("docUpdates", { uploadId: new Types.ObjectId() })),
      await renderSlackEvent(row("docUpdates", { change: "link_created", shareId: "s1" })),
    ];

    expect(recipient.map((m) => m?.color)).toEqual(Array(4).fill(RECIPIENT));
    expect(workspace.map((m) => m?.color)).toEqual(Array(4).fill(WORKSPACE));
  });

  test("a room carries a folder and a request inbox a tray, wherever one is named", async () => {
    state.doc = { title: "Acme cap table", receivedViaRequestProjectId: null };
    const room = await renderSlackEvent(row("docs", { projectId: new Types.ObjectId() }));
    expect(flat(room)).toContain(":file_folder:");
    expect(flat(room)).not.toContain(":inbox_tray:");

    // The same event into a request inbox, which the app draws differently and so does this.
    state.project = { name: "Diligence uploads", isRequest: true };
    const inbox = await renderSlackEvent(row("docs", { projectId: new Types.ObjectId() }));
    expect(flat(inbox)).toContain(":inbox_tray:");
    expect(flat(inbox)).not.toContain(":file_folder:");
  });

  test("a received file leads with the envelope so the tray marks only the inbox", async () => {
    state.doc = { title: "nda-signed", receivedViaRequestProjectId: new Types.ObjectId() };
    const m = await renderSlackEvent(row("requests", { uploadId: new Types.ObjectId() }));
    const blocks = flat(m);
    expect(blocks).toContain(":incoming_envelope:");
    // One tray, on the inbox — not the lead as well.
    expect(blocks.split(":inbox_tray:")).toHaveLength(2);
  });

  test("every event leads with an emoji in the blocks, and none leaks into the notification text", async () => {
    state.doc = { title: "Q3 Deck", receivedViaRequestProjectId: null };
    const m = await renderSlackEvent(row("docs", { change: "created" }));
    expect(flat(m)).toContain(":page_facing_up:");
    // `text` is read alone by screen readers and mobile notifications, where a leading shortcode is
    // announced before the sentence it decorates.
    expect(m?.text).not.toContain(":");
  });
});
