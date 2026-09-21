/**
 * Two things a link recipient must not be able to do, on the two routes that serve them.
 *
 * - **The processor must read the PDF, not the row.** `POST /api/uploads/:uploadId/process`
 *   reused `rawExtractedText ?? pdfText` whenever either was set, and a recipient holding an
 *   upload secret could put text there: the parse never ran and the summary, the version compare
 *   and the doc body all described a document nobody uploaded. The write side is closed
 *   (`buildPatchUpdate` takes those two fields from an owner only); the second lock is that a
 *   recipient upload ignores the stored value whatever put it there. Pinned by evaluating the
 *   real expression out of the route source — the bug was in that one line, so that one line is
 *   what gets executed here, rather than a paraphrase of it in the test.
 *
 * - **The replace link gets the same burst brake as the request link.**
 *   `POST /api/doc/update/:code/uploads` allocates a version, creates an Upload and hands back a
 *   capability secret for nothing but a token in a URL. It had the atomic daily cap and no
 *   per-minute brake, so the cap could be spent in one round trip — and the sibling route at
 *   `/api/requests/:token/uploads` had a brake, which just moves a flood to whichever link type
 *   is cheaper. Both halves are asserted: that the brake runs before anything is looked up or
 *   created, and that the two routes agree on the bucket key, the limit and the window.
 */
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** Read a `const NAME = 123;` / `123_456;` literal out of a route's source. */
function numericConstant(source: string, name: string): number {
  const m = source.match(new RegExp(`const ${name} = ([0-9_]+)\\s*;`));
  if (!m?.[1]) throw new Error(`no numeric constant ${name} in source`);
  return Number(m[1].replace(/_/g, ""));
}

const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";
const REPLACE_ROUTE = "src/app/api/doc/update/[code]/uploads/route.ts";
const REQUEST_ROUTE = "src/app/api/requests/[token]/uploads/route.ts";

// --- 1. the processor parses the PDF for a recipient upload --------------------------------------

describe("a recipient upload is parsed, never read off its own row", () => {
  /**
   * Pull `const existingText = <expr>;` out of the processor and run it, so this asserts the
   * behaviour of the shipped line instead of a copy of it.
   */
  function existingTextExpression(): (viaUploadSecret: boolean, upload: Record<string, unknown>) => unknown {
    const source = read(PROCESS_ROUTE);
    const m = source.match(/const existingText =([\s\S]*?);\n/);
    expect(m?.[1], "the processor still decides reuse in `const existingText = ...`").toBeTruthy();
    return new Function("viaUploadSecret", "upload", `return (${m![1]});`) as (
      viaUploadSecret: boolean,
      upload: Record<string, unknown>,
    ) => unknown;
  }

  test("text written onto a secret-authorized upload is ignored", () => {
    const evaluate = existingTextExpression();
    // What an attacker would have put there: a body of text the owner's PDF does not contain.
    expect(evaluate(true, { rawExtractedText: "Company X is raising $50M", pdfText: null })).toBeFalsy();
    expect(evaluate(true, { rawExtractedText: null, pdfText: "Company X is raising $50M" })).toBeFalsy();
  });

  test("an owner's own upload still reuses its cached text", () => {
    // Degrade, don't refuse: the guard is about who wrote the value, not about re-doing work for
    // everybody. An owner re-run (retry, stale re-claim) must not re-parse for nothing.
    const evaluate = existingTextExpression();
    expect(evaluate(false, { rawExtractedText: "cached page text", pdfText: null })).toBe("cached page text");
    expect(evaluate(false, { rawExtractedText: null, pdfText: "legacy page text" })).toBe("legacy page text");
    expect(evaluate(false, { rawExtractedText: null, pdfText: null })).toBeFalsy();
  });

  test("a falsy stored value still falls through to the parse", () => {
    // `if (existingText)` is the branch, so `null` and `""` both have to reach `pdfParse`.
    const evaluate = existingTextExpression();
    expect(evaluate(true, {})).toBeFalsy();
    expect(evaluate(false, { rawExtractedText: "" })).toBeFalsy();
  });
});

// --- 2. the replace link's burst brake ------------------------------------------------------------

const DOC = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const ORG = new Types.ObjectId();
const UPLOAD = new Types.ObjectId();

const connectMongo = vi.fn(async () => undefined);
const docFindOne = vi.fn((_filter: Record<string, any>) => ({
  select: () => ({ lean: async () => ({ _id: DOC, userId: OWNER, orgId: ORG, title: "Series A deck" }) }),
}));
const docFindByIdAndUpdate = vi.fn(async () => ({}));
const allocateDocUploadVersion = vi.fn(async () => 2);
const uploadCreate = vi.fn(async (attrs: Record<string, unknown>) => ({ ...attrs, _id: UPLOAD }));
const checkRecipientUploadCap = vi.fn(async () => ({ ok: true }) as any);
const rateLimit = vi.fn(async (_input: { key: string; limit: number; windowMs: number }) => ({
  ok: true,
  remaining: 9,
  retryAfterSec: 0,
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: (...a: any[]) => (docFindOne as any)(...a),
    findByIdAndUpdate: (...a: any[]) => (docFindByIdAndUpdate as any)(...a),
  },
  allocateDocUploadVersion: (...a: any[]) => (allocateDocUploadVersion as any)(...a),
}));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { create: (...a: any[]) => (uploadCreate as any)(...a) } }));
vi.mock("@/lib/models/Org", () => ({
  ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })),
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(), agentFromRequest: () => null }));
vi.mock("@/lib/uploads/recipientCaps", () => ({
  checkRecipientUploadCap: (...a: any[]) => (checkRecipientUploadCap as any)(...a),
  RECIPIENT_UPLOAD_LIMIT_CODE: "RECIPIENT_UPLOAD_LIMIT",
}));
// Only the counter is faked. The IP parsing and the 429 body are the real ones, because the bucket
// key is exactly what the two routes have to agree on.
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, rateLimit: (...a: any[]) => (rateLimit as any)(...a) };
});

const { POST: replacePOST } = await import("@/app/api/doc/update/[code]/uploads/route");

function replaceRequest(ip = "203.0.113.7") {
  return new Request("https://lnkdrp.test/api/doc/update/TOKEN123/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify({ originalFileName: "deck-v2.pdf", contentType: "application/pdf", sizeBytes: 1024 }),
  });
}

const ctx = { params: Promise.resolve({ code: "TOKEN123" }) };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockResolvedValue({ ok: true, remaining: 9, retryAfterSec: 0 });
  checkRecipientUploadCap.mockResolvedValue({ ok: true } as any);
});

describe("the replace link has the same burst brake as the request link", () => {
  test("a normal replacement is not blocked", async () => {
    const res = await replacePOST(replaceRequest(), { params: Promise.resolve({ code: "TOKEN123" }) });
    expect(res.status).toBe(201);
    expect(uploadCreate).toHaveBeenCalledTimes(1);
  });

  test("the counter is keyed per IP, in the bucket the sibling route already uses", async () => {
    await replacePOST(replaceRequest("198.51.100.4"), { params: Promise.resolve({ code: "TOKEN123" }) });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit.mock.calls[0]![0]!.key).toBe("recipient-upload:ip:198.51.100.4");
  });

  test("a flood is refused before anything is looked up or created", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 42 });
    const res = await replacePOST(replaceRequest(), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    // A brake that trips after the row exists is an error message, not a brake.
    expect(docFindOne).not.toHaveBeenCalled();
    expect(allocateDocUploadVersion).not.toHaveBeenCalled();
    expect(uploadCreate).not.toHaveBeenCalled();
  });

  test("the limit and the window match the request-upload route", async () => {
    // Two routes, one recipient, one bucket: if these drift the brake is only as strong as the
    // looser of the two, because the attacker picks the link.
    const requestSource = read(REQUEST_ROUTE);
    const replaceSource = read(REPLACE_ROUTE);
    expect(numericConstant(replaceSource, "START_UPLOAD_PER_IP_LIMIT")).toBe(
      numericConstant(requestSource, "START_UPLOAD_PER_IP_LIMIT"),
    );
    expect(numericConstant(replaceSource, "START_UPLOAD_WINDOW_MS")).toBe(
      numericConstant(requestSource, "START_UPLOAD_WINDOW_MS"),
    );

    await replacePOST(replaceRequest(), ctx);
    const call = rateLimit.mock.calls[0]![0]!;
    expect(call.limit).toBe(numericConstant(requestSource, "START_UPLOAD_PER_IP_LIMIT"));
    expect(call.windowMs).toBe(numericConstant(requestSource, "START_UPLOAD_WINDOW_MS"));
    // And both routes really do share the key shape, not just the numbers.
    expect(requestSource).toContain("recipient-upload:ip:${ip}");
    expect(replaceSource).toContain("recipient-upload:ip:${ip}");
  });
});
