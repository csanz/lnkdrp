/**
 * `resolveClaimLink` — the link an approved download is permission *through*.
 *
 * An approval is not a standing right to a file. It is permission to take one document through the
 * link the recipient actually used, and it has to die with that link. The three claim routes all
 * gate on this resolver, so the rules live here rather than three times over.
 *
 * The case worth the most attention is the data room. A project link fronts many documents, so
 * proving the slug resolves is not enough: without the membership re-check, an approval for one
 * document in a room would be a claim token for every document in it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const resolveShareLink = vi.fn();
const resolveProjectLink = vi.fn();
const findProjectDocument = vi.fn();

vi.mock("@/lib/share/links", () => ({ resolveShareLink: (...a: unknown[]) => resolveShareLink(...a) }));
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink: (...a: unknown[]) => resolveProjectLink(...a) }));
vi.mock("@/lib/share/projectPublic", () => ({ findProjectDocument: (...a: unknown[]) => findProjectDocument(...a) }));

const { resolveClaimLink } = await import("@/lib/share/claimLink");

const APPROVED_DOC = new Types.ObjectId();
const OTHER_DOC = new Types.ObjectId();
const DOC_LINK = { _id: new Types.ObjectId(), shareId: "docSlug1", isDefault: true };
const ROOM_LINK = { _id: new Types.ObjectId(), shareId: "roomSlug1", projectId: new Types.ObjectId() };

beforeEach(() => {
  resolveShareLink.mockReset();
  resolveProjectLink.mockReset();
  findProjectDocument.mockReset();
  resolveShareLink.mockResolvedValue(null);
  resolveProjectLink.mockResolvedValue(null);
  findProjectDocument.mockResolvedValue(null);
});

describe("a document link", () => {
  test("resolves when the link's document is the one that was approved", async () => {
    resolveShareLink.mockResolvedValue({ link: DOC_LINK, doc: { _id: APPROVED_DOC }, refusal: null });

    const got = await resolveClaimLink("docSlug1", APPROVED_DOC);

    expect(got).toEqual({ link: DOC_LINK, refusal: null });
    // A document link is its own document; there is no room to ask about.
    expect(resolveProjectLink).not.toHaveBeenCalled();
  });

  test("refuses when the link points at a different document than the approval", async () => {
    resolveShareLink.mockResolvedValue({ link: DOC_LINK, doc: { _id: OTHER_DOC }, refusal: null });

    expect(await resolveClaimLink("docSlug1", APPROVED_DOC)).toBeNull();
  });

  test("passes the refusal through rather than swallowing it", async () => {
    // The caller decides what a refused link means (all three answer 404); the resolver's job is
    // only to say which link and why.
    resolveShareLink.mockResolvedValue({ link: DOC_LINK, doc: { _id: APPROVED_DOC }, refusal: "expired" });

    expect(await resolveClaimLink("docSlug1", APPROVED_DOC)).toEqual({ link: DOC_LINK, refusal: "expired" });
  });
});

describe("a data-room link", () => {
  test("resolves when the approved document is still in the room", async () => {
    resolveProjectLink.mockResolvedValue({ link: ROOM_LINK, project: { _id: ROOM_LINK.projectId }, refusal: null });
    findProjectDocument.mockResolvedValue({ _id: APPROVED_DOC });

    const got = await resolveClaimLink("roomSlug1", APPROVED_DOC);

    expect(got).toEqual({ link: ROOM_LINK, refusal: null });
    expect(findProjectDocument).toHaveBeenCalledWith({ _id: ROOM_LINK.projectId }, String(APPROVED_DOC));
  });

  test("refuses a document that is not in the room — one approval is not a key to the whole room", async () => {
    resolveProjectLink.mockResolvedValue({ link: ROOM_LINK, project: { _id: ROOM_LINK.projectId }, refusal: null });
    // The membership proof is what says no: the slug is real, the room is real, this document is
    // not in it (or was taken out after the approval was granted).
    findProjectDocument.mockResolvedValue(null);

    expect(await resolveClaimLink("roomSlug1", OTHER_DOC)).toBeNull();
  });

  test("passes a room's refusal through", async () => {
    resolveProjectLink.mockResolvedValue({ link: ROOM_LINK, project: { _id: ROOM_LINK.projectId }, refusal: "disabled" });
    findProjectDocument.mockResolvedValue({ _id: APPROVED_DOC });

    expect(await resolveClaimLink("roomSlug1", APPROVED_DOC)).toEqual({ link: ROOM_LINK, refusal: "disabled" });
  });
});

describe("nothing to resolve", () => {
  test("a slug that matches neither shape is null", async () => {
    expect(await resolveClaimLink("nope", APPROVED_DOC)).toBeNull();
  });

  test("a blank slug or a blank document is null, without asking the database", async () => {
    expect(await resolveClaimLink("", APPROVED_DOC)).toBeNull();
    expect(await resolveClaimLink("docSlug1", "")).toBeNull();
    expect(resolveShareLink).not.toHaveBeenCalled();
  });

  test("whitespace around the slug does not make it a different link", async () => {
    resolveShareLink.mockResolvedValue({ link: DOC_LINK, doc: { _id: APPROVED_DOC }, refusal: null });

    expect(await resolveClaimLink("  docSlug1  ", APPROVED_DOC)).toEqual({ link: DOC_LINK, refusal: null });
    expect(resolveShareLink).toHaveBeenCalledWith("docSlug1");
  });
});
