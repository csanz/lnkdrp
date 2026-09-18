/**
 * `ShareLink` kind invariant — one row is a document link or a project link, never both and never
 * neither (docs/prds/lnkdrp-project-links.md, decision 1).
 *
 * This is the one guarantee the whole audit rests on: every document-scoped query either pins an
 * ObjectId `docId` or filters `kind: { $ne: "project" }`, and both are only safe while a row cannot
 * carry both owners. Unlike the service tests beside it, this exercises the **real** schema — the
 * invariant lives in a `pre("validate")` hook, so nothing here is mocked and nothing connects.
 */
import { describe, expect, test } from "vitest";
import { Types } from "mongoose";

import { DOC_LINK_FILTER, PROJECT_LINK_FILTER, ShareLinkModel } from "@/lib/models/ShareLink";

const ORG_ID = new Types.ObjectId();

/** Fields every row needs regardless of kind. */
function base() {
  return { orgId: ORG_ID, shareId: "srDP4SzZNA5a", label: "Sequoia" };
}

/** Run the document through mongoose validation, returning the error (or null when valid). */
async function validate(doc: InstanceType<typeof ShareLinkModel>): Promise<Error | null> {
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe("ShareLink kind invariant", () => {
  test("a document link validates and is marked kind: doc", async () => {
    const doc = new ShareLinkModel({ ...base(), docId: new Types.ObjectId() });
    expect(await validate(doc)).toBeNull();
    expect(doc.kind).toBe("doc");
    expect(doc.projectId ?? null).toBeNull();
  });

  test("a project link validates and is marked kind: project", async () => {
    const doc = new ShareLinkModel({ ...base(), projectId: new Types.ObjectId() });
    expect(await validate(doc)).toBeNull();
    expect(doc.kind).toBe("project");
    expect(doc.docId ?? null).toBeNull();
  });

  test("the hook overrides a kind that disagrees with the owner", async () => {
    // A caller that passes `kind` by hand must not be able to disguise a project link as a
    // document link: `kind` is derived from the owner, never trusted from the payload.
    const doc = new ShareLinkModel({ ...base(), projectId: new Types.ObjectId(), kind: "doc" });
    expect(await validate(doc)).toBeNull();
    expect(doc.kind).toBe("project");
  });

  test("both owners is refused", async () => {
    const doc = new ShareLinkModel({ ...base(), docId: new Types.ObjectId(), projectId: new Types.ObjectId() });
    expect((await validate(doc))?.message).toMatch(/cannot belong to both/i);
  });

  test("neither owner is refused", async () => {
    const doc = new ShareLinkModel(base());
    expect((await validate(doc))?.message).toMatch(/must belong to a document or a project/i);
  });
});

describe("kind filters", () => {
  test("document links are selected by exclusion, so legacy rows without `kind` still match", () => {
    // Every link written before project links existed has no `kind` field at all. `kind: "doc"`
    // would drop all of them — the bug this filter exists to make impossible.
    expect(DOC_LINK_FILTER).toEqual({ kind: { $ne: "project" } });
    expect(PROJECT_LINK_FILTER).toEqual({ kind: "project" });
  });
});
