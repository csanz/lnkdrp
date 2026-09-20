/**
 * The owner's mailbox is not a safe place to put a button.
 *
 * `downloadRequestOwnerEmail` writes two bare URLs into the owner's mail — `Approve: …` and
 * `Deny: …` — and both routes used to do their work in the GET. Corporate mail security fetches
 * every URL in a message before the human sees it, so a Safe Links / Proofpoint / Mimecast scan
 * approved the download (minting the claim token and emailing the requester a claim link) or
 * permanently denied a legitimate request, with nobody having clicked anything.
 *
 * These tests pin the split: GET only renders a confirmation form, POST carries the write, and the
 * hidden confirmation field the form carries is required — so something that blindly POSTs to a
 * URL it found in the mail still changes nothing.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const SHARE_ID = "shr_abc123";
const TOKEN = "tok_request_secret";
const DOC_ID = "doc_1";

let requestRow: Record<string, unknown> | null = null;

const shareRequestUpdateOne = vi.fn(async (..._a: unknown[]) => ({ modifiedCount: 1 }));
const sendTextEmail = vi.fn(async (..._a: unknown[]) => undefined);
const recordActivity = vi.fn(async (..._a: unknown[]) => undefined);

function chain(value: unknown) {
  return { select: () => chain(value), lean: async () => value };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({
  ShareDownloadRequestModel: {
    findOne: () => chain(requestRow),
    updateOne: (...a: unknown[]) => shareRequestUpdateOne(...a),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { findOne: () => chain({ _id: DOC_ID, title: "Quarterly plan", orgId: "org_1" }) },
}));
vi.mock("@/lib/email/sendTextEmail", () => ({ sendTextEmail: (...a: unknown[]) => sendTextEmail(...a) }));
vi.mock("@/lib/email/templates", () => ({
  downloadRequestApprovedEmail: () => ({ subject: "Download approved", text: "claim link" }),
}));
vi.mock("@/lib/urls", () => ({ getPublicSiteBase: () => "https://lnkdrp.test" }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: unknown[]) => recordActivity(...a) }));

import { GET as approveGet, POST as approvePost } from "@/app/api/share/[shareId]/download-requests/[token]/approve/route";
import { GET as denyGet, POST as denyPost } from "@/app/api/share/[shareId]/download-requests/[token]/deny/route";

const ctx = { params: Promise.resolve({ shareId: SHARE_ID, token: TOKEN }) };

function urlFor(action: "approve" | "deny"): string {
  return `https://lnkdrp.test/api/share/${SHARE_ID}/download-requests/${TOKEN}/${action}`;
}

/** What a mail scanner does: a plain GET of the URL it found in the message body. */
function scannerGet(action: "approve" | "deny"): Request {
  return new Request(urlFor(action), { method: "GET" });
}

function formPost(action: "approve" | "deny", fields: Record<string, string>): Request {
  return new Request(urlFor(action), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Pull the hidden confirmation value out of the rendered card, the way a browser would. */
function confirmFieldFrom(html: string): string {
  const match = /name="confirm" value="([^"]*)"/.exec(html);
  return match ? match[1] : "";
}

/** Every `$set` this test's mocked model was asked to apply, flattened for easy assertions. */
function statusWrites(): string[] {
  return shareRequestUpdateOne.mock.calls
    .map((call) => (call[1] as { $set?: { status?: unknown } } | undefined)?.$set?.status)
    .filter((status): status is string => typeof status === "string");
}

beforeEach(() => {
  shareRequestUpdateOne.mockClear();
  sendTextEmail.mockClear();
  recordActivity.mockClear();
  requestRow = {
    _id: "req_1",
    status: "pending",
    requesterEmail: "reader@example.com",
    docId: DOC_ID,
    ownerUserId: "user_1",
  };
});

describe("approve link", () => {
  test("a GET — a mail scanner fetching the link — leaves the request pending", async () => {
    const res = await approveGet(scannerGet("approve"), ctx);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    // It renders the decision instead of making it.
    expect(html).toContain('<form method="post"');
    expect(html).toContain("Approve this download?");
  });

  test("the owner submitting the form approves and emails the requester", async () => {
    const page = await (await approveGet(scannerGet("approve"), ctx)).text();
    const res = await approvePost(formPost("approve", { confirm: confirmFieldFrom(page) }), ctx);

    expect(res.status).toBe(200);
    expect(statusWrites()).toContain("approved");
    expect(sendTextEmail).toHaveBeenCalledTimes(1);
  });

  test("a POST without the form's confirmation value changes nothing", async () => {
    const res = await approvePost(formPost("approve", {}), ctx);

    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(await res.text()).toContain('<form method="post"');
  });

  test("the deny route's confirmation value does not work on approve", async () => {
    const denyPage = await (await denyGet(scannerGet("deny"), ctx)).text();
    await approvePost(formPost("approve", { confirm: confirmFieldFrom(denyPage) }), ctx);

    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
  });
});

describe("deny link", () => {
  test("a GET leaves the request pending, so a scan cannot deny a real request", async () => {
    const res = await denyGet(scannerGet("deny"), ctx);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    expect(html).toContain('<form method="post"');
    expect(html).toContain("Deny this download?");
  });

  test("the owner submitting the form denies the request", async () => {
    const page = await (await denyGet(scannerGet("deny"), ctx)).text();
    const res = await denyPost(formPost("deny", { confirm: confirmFieldFrom(page) }), ctx);

    expect(res.status).toBe(200);
    expect(statusWrites()).toContain("denied");
  });

  test("a POST without the form's confirmation value changes nothing", async () => {
    await denyPost(formPost("deny", {}), ctx);

    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
  });
});

describe("already settled", () => {
  test("an approved request is not re-approved by a second submit", async () => {
    requestRow = { ...(requestRow as Record<string, unknown>), status: "approved", claimTokenHash: "hash" };
    const res = await approvePost(formPost("approve", { confirm: "anything" }), ctx);

    expect(shareRequestUpdateOne).not.toHaveBeenCalled();
    expect(await res.text()).toContain("Already approved");
  });
});
