/** Download-request dedupe keys on the document too (review Low, public share). */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { pendingDuplicateFilter } from "../../src/lib/share/downloadRequestDedupe";

describe("pendingDuplicateFilter", () => {
  const docA = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
  const docB = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);

  it("matches only a pending request for the same link, document and address inside the window", () => {
    const f = pendingDuplicateFilter({ shareId: "room1", docId: docA, requesterEmail: "a@example.com", now, windowMs: 60_000 });
    expect(f).toEqual({
      shareId: "room1",
      docId: docA,
      requesterEmail: "a@example.com",
      status: "pending",
      createdDate: { $gt: new Date(now - 60_000) },
    });
  });

  it("a second document of the same room is a different key", () => {
    const a = pendingDuplicateFilter({ shareId: "room1", docId: docA, requesterEmail: "a@example.com", now, windowMs: 60_000 });
    const b = pendingDuplicateFilter({ shareId: "room1", docId: docB, requesterEmail: "a@example.com", now, windowMs: 60_000 });
    expect(a.docId).not.toEqual(b.docId);
  });
});
