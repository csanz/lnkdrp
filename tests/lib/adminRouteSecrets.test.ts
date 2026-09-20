/**
 * The admin detail routes, checked against the rule rather than against their own shape.
 *
 * `src/lib/admin/docPrivacy.ts` has a unit test, but the leak was never in the helper — it was in
 * the routes that did not call it, or called it on two of their four collections. Each case below
 * feeds a handler a row with a known capability token in it and asserts that the token does not
 * appear anywhere in the JSON it serialises. The tokens are the reason this is worth a route test
 * and not just a helper test: `requestViewToken` streams a customer's PDF with no session,
 * `uploadSecret` and `replaceUploadToken` overwrite a live document with no session, and the share
 * slug opens the document in any browser — so a staff leak of one of them is an anonymous read or
 * write by anyone it is forwarded to, and no revocation exists for any of them.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const docFindOne = vi.fn();
const docFind = vi.fn();
const uploadFindOne = vi.fn();
const uploadFind = vi.fn();
const projectFindById = vi.fn();
const reviewFind = vi.fn();
const aiRunFindById = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/requireAdmin", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, userId: "staff", email: "staff@lnkdrp.test" })),
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: docFindOne, find: docFind } }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { findOne: uploadFindOne, find: uploadFind } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findById: projectFindById } }));
vi.mock("@/lib/models/Review", () => ({ ReviewModel: { find: reviewFind } }));
vi.mock("@/lib/models/AiRun", () => ({ AiRunModel: { findById: aiRunFindById } }));

const { GET: getDoc } = await import("@/app/api/admin/data/docs/[docId]/route");
const { GET: getUpload } = await import("@/app/api/admin/data/uploads/[uploadId]/route");
const { GET: getProject } = await import("@/app/api/admin/data/projects/[projectId]/route");
const { GET: getRequest } = await import("@/app/api/admin/data/requests/[requestId]/route");
const { GET: getAiRun } = await import("@/app/api/admin/ai-runs/[runId]/route");

const ID = new Types.ObjectId().toString();

/** A Mongoose query stub: every builder call returns itself, `lean()` returns the rows. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const method of ["sort", "skip", "limit", "select", "populate"]) q[method] = () => q;
  q.lean = async () => result;
  return q;
}

function req(): Request {
  return new Request("https://lnkdrp.com/api/admin/data", { headers: { host: "lnkdrp.com" } });
}

/** Every string an attacker would be looking for, with the field it came from. */
const TOKENS = {
  shareId: "slug-that-opens-the-document",
  replaceUploadToken: "replace-token-overwrites-the-pdf",
  uploadSecret: "upload-secret-writes-the-row",
  requestUploadToken: "request-upload-token-plants-files",
  requestViewToken: "request-view-token-streams-pdfs",
  sharePasswordHash: "scrypt-hash-for-offline-cracking",
  sharePasswordSalt: "scrypt-salt",
  sharePasswordEnc: "aes-gcm-ciphertext-of-the-password",
  sharePasswordEncIv: "aes-gcm-iv",
  sharePasswordEncTag: "aes-gcm-tag",
};

const CONTENT = {
  extractedText: "THE ENTIRE TEXT OF THE CUSTOMER PDF",
  rawExtractedText: "THE ENTIRE TEXT OF THE CUSTOMER PDF",
  blobUrl: "https://store123.public.blob.vercel-storage.com.com/private.pdf",
  slideNodes: [{ page: 1, imageUrl: "https://store123.public.blob.vercel-storage.com.com/page1.jpg" }],
  aiOutput: { summary: "WHAT THE DECK SAYS" },
};

/** Fails naming the token, so a regression says which capability escaped. */
function expectNoSecrets(body: unknown, extra: string[] = []) {
  const json = JSON.stringify(body);
  for (const [field, value] of Object.entries(TOKENS)) expect(json, `${field} leaked`).not.toContain(value);
  for (const value of extra) expect(json, `${value} leaked`).not.toContain(value);
}

describe("admin detail routes never serve a capability token or document content", () => {
  beforeEach(() => {
    for (const m of [docFindOne, docFind, uploadFindOne, uploadFind, projectFindById, reviewFind, aiRunFindById]) {
      m.mockReset();
    }
  });

  test("GET /api/admin/data/docs/:docId", async () => {
    docFindOne.mockReturnValue(query({ _id: ID, title: "Series A deck", ...TOKENS, ...CONTENT }));
    docFind.mockReturnValue(query([]));
    uploadFind.mockReturnValue(query([{ _id: ID, docId: ID, ...TOKENS, ...CONTENT }]));

    const res = await getDoc(req(), { params: Promise.resolve({ docId: ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    // The title is how support identifies the row being asked about, and it stays.
    expect(body.doc.title).toBe("Series A deck");
    expectNoSecrets(body, [CONTENT.extractedText, CONTENT.blobUrl, "WHAT THE DECK SAYS", "page1.jpg"]);
    // The presence flags are the replacement, and they still answer the operational question.
    expect(body.doc.content.hasExtractedText).toBe(true);
    expect(body.doc.secrets.hasReplaceUploadToken).toBe(true);
    expect(body.doc.secrets.hasSharePassword).toBe(true);
  });

  test("GET /api/admin/data/uploads/:uploadId", async () => {
    uploadFindOne.mockReturnValue(query({ _id: ID, originalFileName: "deck.pdf", ...TOKENS, ...CONTENT }));

    const res = await getUpload(req(), { params: Promise.resolve({ uploadId: ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.upload.originalFileName).toBe("deck.pdf");
    expectNoSecrets(body, [CONTENT.extractedText, CONTENT.blobUrl]);
    expect(body.upload.secrets.hasUploadSecret).toBe(true);
  });

  test("GET /api/admin/data/projects/:projectId", async () => {
    projectFindById.mockReturnValue(query({ _id: ID, name: "Acme inbound", isRequest: true, ...TOKENS }));

    const res = await getProject(req(), { params: Promise.resolve({ projectId: ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.project.raw.name).toBe("Acme inbound");
    expectNoSecrets(body);
    expect(body.project.raw.secrets.hasRequestViewToken).toBe(true);
    expect(body.project.raw.secrets.hasRequestUploadToken).toBe(true);
  });

  test("GET /api/admin/data/requests/:requestId", async () => {
    projectFindById.mockReturnValue(query({ _id: ID, name: "Acme inbound", isRequest: true, ...TOKENS }));
    docFind.mockReturnValue(query([{ _id: ID, title: "Pitch", ...TOKENS, ...CONTENT }]));
    uploadFind.mockReturnValue(query([{ _id: ID, docId: ID, ...TOKENS, ...CONTENT }]));
    reviewFind.mockReturnValue(
      query([
        {
          _id: ID,
          docId: ID,
          status: "completed",
          inputTextChars: 41_000,
          // The route's own `.select()` leaves these behind; they are here to prove the second lock
          // holds if that select is ever widened back.
          prompt: `DECK:\n${CONTENT.extractedText}`,
          agentUserPrompt: CONTENT.extractedText,
          outputMarkdown: "## Assessment\nWHAT THE DECK SAYS",
          intel: { contact: { email: "founder@acme.example" } },
        },
      ]),
    );

    const res = await getRequest(req(), { params: Promise.resolve({ requestId: ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.raw.name).toBe("Acme inbound");
    expectNoSecrets(body, [
      CONTENT.extractedText,
      CONTENT.blobUrl,
      "WHAT THE DECK SAYS",
      "founder@acme.example",
    ]);
    expect(body.reviews[0].status).toBe("completed");
    expect(body.reviews[0].inputTextChars).toBe(41_000);
  });

  test("GET /api/admin/ai-runs/:runId", async () => {
    aiRunFindById.mockReturnValue(
      query({
        _id: ID,
        kind: "analyzePdfText",
        status: "completed",
        inputTextChars: 41_000,
        systemPrompt: "You are a reviewer.\n\nPROJECTS:\nAcme fundraise",
        userPrompt: CONTENT.extractedText,
        outputText: "WHAT THE DECK SAYS",
        outputObject: { summary: "WHAT THE DECK SAYS" },
        error: { message: "rate limited" },
      }),
    );

    const res = await getAiRun(req(), { params: Promise.resolve({ runId: ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expectNoSecrets(body, [CONTENT.extractedText, "WHAT THE DECK SAYS", "Acme fundraise"]);
    // Sizes and the run's own failure are the diagnostics, and both survive.
    expect(body.run.content.userPromptChars).toBe(CONTENT.extractedText.length);
    expect(body.run.content.hasOutputObject).toBe(true);
    expect(body.run.error).toEqual({ message: "rate limited" });
  });
});

/**
 * The list routes are the other half: one page of 200 rows was 200 working links into customer
 * documents, which is worse per request than any single detail route.
 */
describe("admin list routes never serve a share slug or an upload token", () => {
  test("the doc, link, project and request listings project no capability field", async () => {
    const sources = await Promise.all(
      [
        "src/app/api/admin/data/docs/route.ts",
        "src/app/api/admin/data/links/route.ts",
        "src/app/api/admin/data/projects/route.ts",
        "src/app/api/admin/data/requests/route.ts",
        "src/app/api/admin/data/uploads/route.ts",
        "src/app/api/admin/emails/download-requests/route.ts",
        "src/app/api/admin/shareviews/recent/route.ts",
        "src/app/api/admin/shareviews/doc/[docId]/route.ts",
      ].map(async (path) => [path, await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))] as const),
    );

    for (const [path, src] of sources) {
      // A response object assigns the field: `shareId: <something>`. A filter or a `.select()` uses
      // `shareId: rx` or `shareId: 1`, and a slug an admin was handed must stay searchable, so
      // those two shapes are the exceptions rather than the rule being relaxed.
      const assignments = [...src.matchAll(/\b(shareId|requestUploadToken|requestViewToken|uploadSecret)\s*:\s*([^,\n]+)/g)];
      const offenders = assignments.filter(([, , value]) => !/^(1|rx|\{)/.test(value.trim()));
      expect(offenders.map((m) => m[0]), path).toEqual([]);
    }
  });
});
