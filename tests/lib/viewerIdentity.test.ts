/**
 * A recipient who corrects the name they gave must be renamed everywhere that owner can see them
 * (`src/lib/share/viewerIdentity.ts`).
 *
 * This is pinned rather than left to review because the failure is invisible in the code and
 * obvious to the owner: "introduce yourself" is asked once per browser, so the second answer only
 * ever reaches the row for the link it was typed on, and the same person shows up under two names
 * on two pages — the document's metrics page and the workspace's — with nothing in either to
 * suggest they are the same reader.
 *
 * The assertions are about the filter the update *issues*, which is where all four rules live:
 * this person's rows only (including the project keys that carry a document suffix), never over an
 * account-backed identity, only where something actually differs — that last one because the
 * realtime server watches these two fields, and a write that changes nothing would still tell every
 * open metrics page to refetch — and, the first rule, **how far the rename reaches**.
 *
 * That last one narrowed. It used to be "one workspace", full stop, and that was too generous: a
 * viewer's name and email are typed into a public box by whoever holds the link, with nothing
 * proving either. So one stranger's claim was written across every row that workspace had for that
 * browser. It is now one workspace only once the address has been *confirmed* by a click in the
 * verification mail (`emailVerified`); until then — and for a name with no address at all — the
 * rename reaches only the link it was typed on. See `identityFanOutScope`.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const updateMany = vi.fn(async (_filter: Record<string, any>, _update: Record<string, any>) => ({ modifiedCount: 3 }));
/** The arrival rows — one per (project link, person), keyed on the bare digest. */
const projectUpdateMany = vi.fn(async (_filter: Record<string, any>, _update: Record<string, any>) => ({ modifiedCount: 1 }));

/** `findOne(...).select(...).sort(...).lean()` — the prior identity, per collection. */
const shareViewPrior = vi.fn(async () => null as unknown);
const projectPrior = vi.fn(async () => null as unknown);
const chain = (leaf: () => Promise<unknown>) => ({ select: () => ({ sort: () => ({ lean: leaf }) }) });

vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    updateMany: (filter: Record<string, any>, update: Record<string, any>) => updateMany(filter, update),
    findOne: () => chain(shareViewPrior),
  },
}));

vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: {
    updateMany: (filter: Record<string, any>, update: Record<string, any>) => projectUpdateMany(filter, update),
    findOne: () => chain(projectPrior),
  },
}));

const { propagateViewerIdentity, viewerIdentityNews } = await import("@/lib/share/viewerIdentity");

const ORG_ID = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();
const DIGEST = "a".repeat(64);

/** The filter of the single `updateMany` the call issues. */
function filter(): Record<string, any> {
  expect(updateMany).toHaveBeenCalledTimes(1);
  return updateMany.mock.calls[0]![0] as Record<string, any>;
}

function update(): Record<string, any> {
  return updateMany.mock.calls[0]![1] as Record<string, any>;
}

/** Find the `$or` clause that lists the viewer keys. */
function viewerClause(): Array<Record<string, any>> {
  const and = filter().$and as Array<Record<string, any>>;
  const clause = and.find((c) => JSON.stringify(c).includes(DIGEST));
  expect(clause, "no clause matches the viewer's digest").toBeTruthy();
  return clause!.$or as Array<Record<string, any>>;
}

describe("propagateViewerIdentity", () => {
  beforeEach(() => {
    updateMany.mockClear();
    projectUpdateMany.mockClear();
  });

  test("a confirmed address renames this person across the workspace", async () => {
    const n = await propagateViewerIdentity({
      shareId: "the-link",
      botIdHash: DIGEST,
      orgId: ORG_ID,
      name: "Michael Jay",
      email: "Michael@Example.com",
      // The reader clicked the link in the verification mail: the address is theirs.
      emailVerified: true,
    });

    // Reading rows and the arrival row, both renamed.
    expect(n).toBe(4);
    // Scoped to the document owner's workspace: telling this owner who you are is not telling
    // every owner whose links you have ever opened.
    expect(filter().orgId).toBe(ORG_ID);
    expect(filter().shareId).toBeUndefined();
    expect(update().$set).toEqual({ viewerName: "Michael Jay", viewerEmailSnapshot: "michael@example.com" });
  });

  test("an unconfirmed address reaches only the link it was typed on", async () => {
    // This assertion is the inverse of the one above, and it is the one that changed. Anyone
    // holding the link can type any name and any address into that box; until a click proves the
    // address, treating the claim as a fact about the reader — and stamping it across every row
    // the workspace holds for that browser — is taking a stranger's word for who they are.
    await propagateViewerIdentity({
      shareId: "the-link",
      botIdHash: DIGEST,
      orgId: ORG_ID,
      name: "Michael Jay",
      email: "Michael@Example.com",
    });

    expect(filter().shareId).toBe("the-link");
    expect(filter().orgId).toBeUndefined();
  });

  test("covers the project-link rows, whose key carries the document too", async () => {
    await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, name: "Michael Jay" });

    const or = viewerClause();
    // The bare digest (a document link) …
    expect(or).toContainEqual({ botIdHash: DIGEST });
    // … and every project key, which is `<digest>.<docId>` — one row per document read in the room.
    const prefix = or.find((c) => c.botIdHash?.$regex);
    expect(prefix).toBeTruthy();
    expect(new RegExp(prefix!.botIdHash.$regex).test(`${DIGEST}.${DOC_ID}`)).toBe(true);
    // Not a different reader who merely starts with the same characters.
    expect(new RegExp(prefix!.botIdHash.$regex).test(`${"b".repeat(64)}.${DOC_ID}`)).toBe(false);
  });

  test("is given a project key and still finds the person's other rows", async () => {
    // The heartbeat that carried the new name came from inside a data room, so the key it wrote
    // under has the document appended. The person is the digest in front of it.
    await propagateViewerIdentity({
      shareId: "the-room",
      botIdHash: `${DIGEST}.${DOC_ID}`,
      orgId: ORG_ID,
      name: "Michael Jay",
    });
    expect(viewerClause()).toContainEqual({ botIdHash: DIGEST });
  });

  test("never writes over an identity that came from an account", async () => {
    await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, name: "Michael Jay" });
    const and = filter().$and as Array<Record<string, any>>;
    expect(and).toContainEqual({ $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] });
  });

  test("only touches rows where something differs, so no frame goes out for a no-op", async () => {
    await propagateViewerIdentity({
      shareId: "the-link",
      botIdHash: DIGEST,
      orgId: ORG_ID,
      name: "Michael Jay",
      email: "michael@example.com",
    });
    const and = filter().$and as Array<Record<string, any>>;
    expect(and).toContainEqual({
      $or: [{ viewerName: { $ne: "Michael Jay" } }, { viewerEmailSnapshot: { $ne: "michael@example.com" } }],
    });
  });

  test("writes only the fields that were given", async () => {
    await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, email: "m@example.com" });
    expect(update().$set).toEqual({ viewerEmailSnapshot: "m@example.com" });
  });

  test("falls back to the link when the row has no workspace on it", async () => {
    await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: null, name: "Michael Jay" });
    expect(filter().shareId).toBe("the-link");
    expect(filter().orgId).toBeUndefined();
  });

  test("does nothing at all when there is no identity to write", async () => {
    expect(await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID })).toBe(0);
    expect(await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, name: "   " })).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(projectUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * The arrival row is the only one a visitor who opens a data room and reads nothing ever writes,
   * so it is exactly the row where a name is worth most — and it was the one row the rename missed.
   */
  test("renames the arrival row too, on the bare digest", async () => {
    await propagateViewerIdentity({ shareId: "the-room", botIdHash: `${DIGEST}.${DOC_ID}`, orgId: ORG_ID, name: "Michael Jay" });

    expect(projectUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = projectUpdateMany.mock.calls[0]! as [Record<string, any>, Record<string, any>];
    // A bare name with no address is a claim like any other, so it stays on its own link. This
    // used to assert `orgId` — see the note at the top of the file for why that narrowed.
    expect(filter.shareId).toBe("the-room");
    expect(filter.orgId).toBeUndefined();
    expect(update.$set).toEqual({ viewerName: "Michael Jay" });
    // `ProjectLinkView` is about the person, not what they read: no document suffix, so no prefix
    // match — an equality test on the digest.
    const and = filter.$and as Array<Record<string, any>>;
    expect(and[0]).toEqual({ botIdHash: DIGEST });
    expect(and).toContainEqual({ $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] });
    expect(and).toContainEqual({ $or: [{ viewerName: { $ne: "Michael Jay" } }] });
  });

  test("an arrival-row failure never costs the reading rows their rename", async () => {
    projectUpdateMany.mockRejectedValueOnce(new Error("mongo is having a moment"));

    const n = await propagateViewerIdentity({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, name: "Michael Jay" });

    expect(n).toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * The viewer replays its stored profile on every heartbeat, so "someone introduced themselves"
 * has to be told apart from "someone is still reading, with a name we already have". Without that,
 * one introduction would land in the feed every few seconds for as long as they kept the tab open.
 */
describe("viewerIdentityNews", () => {
  beforeEach(() => {
    shareViewPrior.mockResolvedValue(null);
    projectPrior.mockResolvedValue(null);
  });

  const ask = () =>
    viewerIdentityNews({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID, name: "John J", email: "john@example.com" });

  test("nobody has heard of them: a first introduction", async () => {
    expect(await ask()).toEqual({ isNew: true, changed: false });
  });

  test("a row exists but carries no identity: still a first introduction", async () => {
    shareViewPrior.mockResolvedValue({ viewerName: null, viewerEmailSnapshot: null });
    expect(await ask()).toEqual({ isNew: true, changed: false });
  });

  test("already carrying exactly this: a replayed heartbeat, not news", async () => {
    shareViewPrior.mockResolvedValue({ viewerName: "John J", viewerEmailSnapshot: "john@example.com" });
    expect(await ask()).toEqual({ isNew: false, changed: false });
  });

  test("a different name is a correction, not a new contact", async () => {
    shareViewPrior.mockResolvedValue({ viewerName: "John", viewerEmailSnapshot: "john@example.com" });
    expect(await ask()).toEqual({ isNew: false, changed: true });
  });

  test("the arrival row alone can answer it", async () => {
    // Someone who opened the data room and read nothing owns no ShareView row at all.
    projectPrior.mockResolvedValue({ viewerName: "John J", viewerEmailSnapshot: "john@example.com" });
    expect(await ask()).toEqual({ isNew: false, changed: false });
  });

  test("nothing volunteered is never news", async () => {
    expect(await viewerIdentityNews({ shareId: "the-link", botIdHash: DIGEST, orgId: ORG_ID })).toEqual({
      isNew: false,
      changed: false,
    });
  });

  test("a failed read announces nothing: a duplicate row is worse than a missing one", async () => {
    shareViewPrior.mockRejectedValue(new Error("mongo is having a moment"));
    expect(await ask()).toEqual({ isNew: false, changed: false });
  });
});
