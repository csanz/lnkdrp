import { describe, expect, it } from "vitest";

import {
  AI_RUN_CONTENT_FIELDS,
  DOC_CONTENT_FIELDS,
  REVIEW_CONTENT_FIELDS,
  SECRET_FIELDS,
  describeAiRunContent,
  redactDocRow,
  redactDocRows,
  redactReviewRow,
  stripSecrets,
} from "@/lib/admin/docPrivacy";

/**
 * Admin sees a document's metadata, never the document. The admin doc and upload routes used to
 * return the file URL (a public blob link), the preview images, the extracted text and the AI
 * output, so reading a customer's document was one request.
 */
describe("redactDocRow", () => {
  const row = {
    id: "doc1",
    title: "Series A deck",
    status: "ready",
    sizeBytes: 12345,
    blobUrl: "https://blob.example.com/secret.pdf",
    blobPathname: "org/doc/secret.pdf",
    previewImageUrl: "https://blob.example.com/p.png",
    firstPagePngUrl: "https://blob.example.com/1.png",
    extractedTextBlobUrl: "https://blob.example.com/t.txt",
    extractedTextBlobPathname: "org/doc/t.txt",
    rawExtractedText: "the whole document text",
    pdfText: "the whole document text",
    extractedText: "the whole document text",
    slideNodes: [
      { page: 1, imageUrl: "https://blob.example.com/s1.jpg", thumbUrl: "https://blob.example.com/t1.jpg" },
      { page: 2, imageUrl: "https://blob.example.com/s2.jpg", thumbUrl: "https://blob.example.com/t2.jpg" },
    ],
    aiOutput: { summary: "what the document says" },
    pageSlugs: ["a", "b", "c"],
  };

  it("removes every content field", () => {
    const out = redactDocRow(row) as Record<string, unknown>;
    for (const f of DOC_CONTENT_FIELDS) expect(out[f], f).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("blob.example.com");
    expect(JSON.stringify(out)).not.toContain("the whole document text");
    expect(JSON.stringify(out)).not.toContain("what the document says");
  });

  /**
   * `extractedText` is what the processing pipeline writes the PDF's text into on every run, and
   * `slideNodes` carries a public blob URL per page of the deck. Both survived the first version of
   * this list, so the doc detail route returned the document's full text and its page images under
   * a banner promising it did not.
   */
  it("removes the two fields the first version of the list missed", () => {
    const out = redactDocRow(row) as Record<string, unknown>;
    expect(out.extractedText).toBeUndefined();
    expect(out.slideNodes).toBeUndefined();
  });

  it("keeps the metadata an admin needs to identify and diagnose the row", () => {
    const out = redactDocRow(row);
    expect(out.title).toBe("Series A deck");
    expect(out.status).toBe("ready");
    expect(out.sizeBytes).toBe(12345);
  });

  it("reports what was there instead of the content itself", () => {
    const out = redactDocRow(row);
    expect(out.content).toEqual({
      hasFile: true,
      hasPreviewImage: true,
      hasFirstPagePng: true,
      hasExtractedText: true,
      extractedTextChars: "the whole document text".length,
      hasAiOutput: true,
      pageCount: 3,
      slideImageCount: 2,
    });
  });

  it("sizes the text when only `extractedText` holds it", () => {
    const out = redactDocRow({ extractedText: "abcde" });
    expect(out.content.hasExtractedText).toBe(true);
    expect(out.content.extractedTextChars).toBe(5);
  });

  it("an empty row reports nothing stored rather than throwing", () => {
    const out = redactDocRow({});
    expect(out.content.hasFile).toBe(false);
    expect(out.content.extractedTextChars).toBeNull();
    expect(out.content.pageCount).toBeNull();
    expect(out.content.slideImageCount).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = { ...row };
    redactDocRow(input);
    expect(input.blobUrl).toBe("https://blob.example.com/secret.pdf");
  });

  it("redacts a list", () => {
    const out = redactDocRows([row, row]);
    expect(out).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain("blob.example.com");
  });
});

/**
 * Content is a disclosure; a capability token is access. It works from any browser with no session,
 * and nobody can revoke it — so a slug or a token in an admin payload defeats every content field
 * stripped beside it.
 */
describe("capability tokens", () => {
  const tokens = {
    shareId: "pub-slug-abc",
    replaceUploadToken: "replace-token-abc",
    uploadSecret: "upload-secret-abc",
    requestUploadToken: "request-upload-abc",
    requestViewToken: "request-view-abc",
    sharePasswordSalt: "salt-abc",
    sharePasswordHash: "hash-abc",
    sharePasswordEnc: "enc-abc",
    sharePasswordEncIv: "iv-abc",
    sharePasswordEncTag: "tag-abc",
    passwordSalt: "link-salt-abc",
    passwordHash: "link-hash-abc",
    passwordEnc: "link-enc-abc",
    passwordEncIv: "link-iv-abc",
    passwordEncTag: "link-tag-abc",
  };

  it("`SECRET_FIELDS` names every token on the row shapes admin routes return", () => {
    for (const f of SECRET_FIELDS) expect(tokens, f).toHaveProperty(f);
  });

  it("strips every one of them and leaves nothing of the value behind", () => {
    const out = stripSecrets({ name: "Acme repo", isRequest: true, ...tokens }) as Record<string, unknown>;
    for (const f of SECRET_FIELDS) expect(out[f], f).toBeUndefined();
    for (const value of Object.values(tokens)) expect(JSON.stringify(out)).not.toContain(value);
    expect(out.name).toBe("Acme repo");
  });

  it("reports which capabilities existed, so support can still answer for them", () => {
    const out = stripSecrets(tokens);
    expect(out.secrets).toEqual({
      hasShareLink: true,
      hasSharePassword: true,
      hasReplaceUploadToken: true,
      hasUploadSecret: true,
      hasRequestUploadToken: true,
      hasRequestViewToken: true,
    });
  });

  /**
   * A route that stops selecting a secret is the improvement this file exists to enable. A flag
   * that answered `false` for a field nobody looked up would turn that into a confident wrong
   * answer on a support call, so "not looked up" is its own value.
   */
  it("says `null`, not `false`, for a field the route never selected", () => {
    const out = stripSecrets({ title: "Deck", shareId: "" });
    expect(out.secrets.hasShareLink).toBe(false);
    expect(out.secrets.hasUploadSecret).toBeNull();
    expect(out.secrets.hasRequestViewToken).toBeNull();
  });

  it("`redactDocRow` strips tokens as well as content", () => {
    const out = redactDocRow({ title: "Deck", rawExtractedText: "text", ...tokens }) as Record<string, unknown>;
    for (const f of SECRET_FIELDS) expect(out[f], f).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("replace-token-abc");
    expect(JSON.stringify(out)).not.toContain("pub-slug-abc");
  });
});

/**
 * A Review's prompt is the deck's extracted text and its output is the AI's reading of that deck.
 * The request-repo route redacted the doc row and then printed the same document as a prompt in the
 * tab beside it.
 */
describe("redactReviewRow", () => {
  const review = {
    id: "rev1",
    status: "completed",
    model: "gpt-4o-mini",
    inputTextChars: 41_000,
    prompt: "GUIDE:\n...\nDECK:\nthe whole pitch deck text",
    agentUserPrompt: "the whole pitch deck text again",
    agentSystemPrompt: "REQUESTER INSTRUCTIONS: look for seed-stage fintech",
    outputMarkdown: "## Assessment\nStrong team, thin traction",
    agentRawOutputText: '{"stage_match":true}',
    agentOutput: { stage_match: true },
    intel: { company: { name: "Acme" }, contact: { email: "founder@acme.example" } },
  };

  it("removes every prompt and every piece of the analysis", () => {
    const out = redactReviewRow(review) as Record<string, unknown>;
    for (const f of REVIEW_CONTENT_FIELDS) expect(out[f], f).toBeUndefined();
    const json = JSON.stringify(out);
    expect(json).not.toContain("pitch deck text");
    expect(json).not.toContain("seed-stage fintech");
    expect(json).not.toContain("Strong team");
    expect(json).not.toContain("founder@acme.example");
  });

  it("keeps the run's shape, which is what the admin page is for", () => {
    const out = redactReviewRow(review);
    expect(out.status).toBe("completed");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.inputTextChars).toBe(41_000);
    expect(out.review.hasPrompt).toBe(true);
    expect(out.review.hasOutput).toBe(true);
    expect(out.review.hasIntel).toBe(true);
    expect(out.review.promptChars).toBe(review.prompt.length);
  });

  it("a row selected without its content reports unknown rather than empty", () => {
    const out = redactReviewRow({ status: "failed", inputTextChars: 0 });
    expect(out.review.hasPrompt).toBeNull();
    expect(out.review.hasOutput).toBeNull();
    expect(out.status).toBe("failed");
  });
});

/**
 * An AI run's `userPrompt` is the document's text substituted into a template, its output is the
 * model's reading of that document, and its `systemPrompt` carries the requester's own instructions
 * and the customer's project descriptions. None of the four is a diagnostic; their sizes are.
 */
describe("describeAiRunContent", () => {
  const run = {
    systemPrompt: "You are a reviewer.\n\nPROJECTS:\nAcme fundraise",
    userPrompt: "x".repeat(220_000),
    outputText: "The deck describes a fintech at seed",
    outputObject: { summary: "fintech at seed" },
    error: null,
  };

  it("names the four fields that must never reach an admin payload", () => {
    expect([...AI_RUN_CONTENT_FIELDS]).toEqual(["systemPrompt", "userPrompt", "outputText", "outputObject"]);
  });

  it("reports sizes and never the text", () => {
    const out = describeAiRunContent(run);
    expect(out).toEqual({
      hasSystemPrompt: true,
      systemPromptChars: run.systemPrompt.length,
      hasUserPrompt: true,
      userPromptChars: 220_000,
      hasOutputText: true,
      outputTextChars: run.outputText.length,
      hasOutputObject: true,
    });
    expect(JSON.stringify(out)).not.toContain("fintech");
    expect(JSON.stringify(out)).not.toContain("Acme");
  });

  it("a started run that has produced nothing yet reads as empty, not missing", () => {
    const out = describeAiRunContent({ systemPrompt: "s", userPrompt: "u", outputText: null, outputObject: null });
    expect(out.hasOutputText).toBe(false);
    expect(out.hasOutputObject).toBe(false);
    expect(out.outputTextChars).toBeNull();
  });
});
