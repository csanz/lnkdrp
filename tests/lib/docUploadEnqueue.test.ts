/**
 * Who gets told a teammate added a document — the enqueue, not the email.
 *
 * `docUploadEmail.test.ts` covers what the mail says. This covers the only two decisions made
 * before it exists, both of them in `process/route.ts` and both invisible when they go wrong:
 *
 * - **This fires on a new document and on nothing else.** The queue kind sits inside a route that
 *   also handles replacements, recipient uploads and summary reruns. If the gate ever widens, every
 *   member gets "someone added a document" for a file they already have, on every replacement —
 *   and the product's own PRD makes a teammate's *new* document a different event from a
 *   *replacement* precisely so that cannot happen.
 * - **The uploader is skipped.** An email confirming your own action is the fastest way to teach
 *   somebody to filter this whole class of mail, and it is what makes the feature inert in a
 *   personal workspace, whose one member is always the uploader. Nothing else in the pipeline
 *   re-checks this: enqueue is the only place the uploader can be dropped.
 *
 * Asserted by evaluating the shipped expressions out of the route source, the way
 * `processCompareCredits.test.ts` does. The defect this guards against would live in those exact
 * lines, so those lines are what run here rather than a paraphrase of them.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { notificationDedupeKey } from "@/lib/notifications/queue";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROCESS_ROUTE = "src/app/api/uploads/[uploadId]/process/route.ts";
const source = fs.readFileSync(path.join(REPO_ROOT, PROCESS_ROUTE), "utf8");

/** The block that enqueues `doc_uploads`, from its gate to the end of the enqueue call. */
function docUploadBlock(): string {
  const at = source.indexOf('kind: "doc_uploads"');
  expect(at, 'the route still enqueues kind: "doc_uploads"').toBeGreaterThan(-1);
  const gateAt = source.lastIndexOf("if (!isReplacement", at);
  expect(gateAt, "the enqueue is still guarded by an `if (!isReplacement` gate").toBeGreaterThan(-1);
  return source.slice(gateAt, at + 400);
}

describe("when a new-document email is queued at all", () => {
  /** The shipped `if (...)` condition, compiled so the real expression decides. */
  function gate(): (
    isReplacement: boolean,
    summaryRerun: boolean,
    docWriteLanded: boolean,
    viaUploadSecret: boolean,
  ) => boolean {
    const block = docUploadBlock();
    const expr = /^if \(([^)]*)\) \{/.exec(block)?.[1];
    expect(expr, "the gate is still a single `if (...) {` line").toBeTruthy();
    return new Function(
      "isReplacement",
      "summaryRerun",
      "docWriteLanded",
      "viaUploadSecret",
      `return Boolean(${expr});`,
    ) as (a: boolean, b: boolean, c: boolean, d: boolean) => boolean;
  }

  test("a genuinely new document queues", () => {
    expect(gate()(false, false, true, false)).toBe(true);
  });

  test("a replacement does not — that is doc_updates' event, and this mail would be a lie about it", () => {
    expect(gate()(true, false, true, false)).toBe(false);
  });

  test("a summary rerun does not: nothing arrived, someone pressed a button on a document already there", () => {
    expect(gate()(false, true, true, false)).toBe(false);
  });

  test("a write that did not land does not — no email about a document nobody can open", () => {
    expect(gate()(false, false, false, false)).toBe(false);
  });

  /**
   * The preamble above named "recipient uploads" as a case the gate must exclude, and nothing
   * asserted it — so the first version shipped without the term and a pre-merge review found it.
   *
   * A file dropped into a request inbox arrives on the secret-auth path, where the actor is
   * synthesised from the Upload row, and `POST /api/requests/:token/uploads` creates both Doc and
   * Upload as the *repo owner*. So "skip the uploader" dropped the owner — the one person the
   * arrival is addressed to — and told every other member "<Owner> added contract.pdf" about a
   * file the owner never touched. With NEXT_PUBLIC_FEATURE_REQUESTS unset, the correctly
   * attributed repo_link_requests mail is withheld, so only the wrong one went out.
   */
  test("an outside recipient's drop-off does not — that is repo_link_requests' event", () => {
    expect(gate()(false, false, true, true)).toBe(false);
  });

  test("the two fan-outs partition on viaUploadSecret rather than overlapping", () => {
    const src = source;
    expect(src).toContain("!isReplacement && !summaryRerun && docWriteLanded && !viaUploadSecret");
    expect(src).toContain("!isReplacement && docWriteLanded && viaUploadSecret");
  });
});

describe("who it is queued for", () => {
  /** The shipped skip, compiled: `if (memberUserId === uploaderUserId) return;`. */
  function skipsUploader(): (memberUserId: string, uploaderUserId: string) => boolean {
    const block = docUploadBlock();
    const expr = /if \((memberUserId === uploaderUserId)\) return;/.exec(block)?.[1];
    expect(expr, "the uploader is still dropped by comparing the member to the uploader").toBeTruthy();
    return new Function("memberUserId", "uploaderUserId", `return Boolean(${expr});`) as (
      a: string,
      b: string,
    ) => boolean;
  }

  test("the person who pressed upload is dropped", () => {
    expect(skipsUploader()("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011")).toBe(true);
  });

  test("every other member is kept", () => {
    expect(skipsUploader()("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012")).toBe(false);
  });

  test("the comparison is on strings, so two ids equal as ObjectIds are still equal here", () => {
    // Both sides are `String(...)`-ed at the point of use; this fails loudly if one ever stops being.
    expect(docUploadBlock()).toMatch(/const memberUserId = m\?\.userId \? String\(m\.userId\) : "";/);
    expect(source).toMatch(/const uploaderUserId = actor\?\.userId \? String\(actor\.userId\) : "";/);
  });

  test("a member row with an unusable id is skipped rather than queued against a bad key", () => {
    expect(docUploadBlock()).toContain("if (!Types.ObjectId.isValid(memberUserId)) return;");
  });

  test("the whole workspace is asked, not just live-linked members", () => {
    // A membership query that grew a filter would silently narrow who hears about new documents.
    expect(docUploadBlock()).toMatch(/OrgMembershipModel\.find\(\{\s*orgId: existingDocOrgId,\s*isDeleted: \{ \$ne: true \},\s*\}\)/);
  });
});

describe("the dedupe key", () => {
  test("is per member and per upload, so one upload cannot mail one person twice", () => {
    // The route is re-entered for a single upload more often than any other in the product.
    expect(docUploadBlock()).toContain('notificationDedupeKey("doc_uploads", memberUserId, uploadId)');

    const a = notificationDedupeKey("doc_uploads", "507f1f77bcf86cd799439011", "68c1f0a2b3c4d5e6f7a80001");
    expect(notificationDedupeKey("doc_uploads", "507f1f77bcf86cd799439011", "68c1f0a2b3c4d5e6f7a80001")).toBe(a);
    // A different member, or a different upload, is a different email.
    expect(notificationDedupeKey("doc_uploads", "507f1f77bcf86cd799439012", "68c1f0a2b3c4d5e6f7a80001")).not.toBe(a);
    expect(notificationDedupeKey("doc_uploads", "507f1f77bcf86cd799439011", "68c1f0a2b3c4d5e6f7a80002")).not.toBe(a);
    // And so is the same upload under another kind: doc_updates must not suppress doc_uploads.
    expect(notificationDedupeKey("doc_updates", "507f1f77bcf86cd799439011", "68c1f0a2b3c4d5e6f7a80001")).not.toBe(a);
  });
});

describe("it cannot take the upload down with it", () => {
  test("the enqueue is fire-and-forget, inside its own try", () => {
    // An upload that failed because a notification could not be queued would be the worse bug.
    const block = docUploadBlock();
    expect(block).toContain("void (async () => {");
    expect(block).toContain("try {");
    expect(source.slice(source.indexOf('kind: "doc_uploads"'))).toContain('"[process] doc_uploads enqueue failed"');
  });
});
