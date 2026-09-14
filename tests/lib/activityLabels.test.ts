import { describe, expect, test } from "vitest";

import { ACTIVITY_FILTERS, describeActivity, type ActivityItem } from "@/lib/activity/labels";

function item(type: string, meta: Record<string, unknown> = {}, actor: Partial<ActivityItem["actor"]> = {}): ActivityItem {
  return {
    id: "a1",
    type,
    createdDate: new Date().toISOString(),
    actor: { userId: null, name: null, email: null, kind: "viewer", ...actor },
    agent: null,
    doc: { id: "d1", title: "Deck", shareId: "DEFAULT" },
    project: null,
    meta,
  } as ActivityItem;
}

const text = (i: ActivityItem) => {
  const d = describeActivity(i);
  return [d.subject, d.verb, typeof d.object === "string" ? d.object : "", d.suffix].filter(Boolean).join(" ");
};

describe("activity labels", () => {
  test("downloads name the recipient when known, and say which link", () => {
    expect(text(item("share.downloaded", { viewerName: "Test Person", linkLabel: "Sequoia" }))).toBe("Test Person downloaded Deck via Sequoia");
    expect(text(item("share.downloaded", { linkLabel: "Sequoia" }))).toBe("Someone downloaded Deck via Sequoia");
  });

  test("download requests say which link they came through", () => {
    expect(text(item("download_request.created", { email: "r***@example.com", linkLabel: "Benchmark" }, { kind: "secret" }))).toBe(
      "r***@example.com requested to download Deck via Benchmark",
    );
  });

  test("a single link change reads specifically; several read as settings", () => {
    const u = (values: Record<string, unknown>) => text(item("share_link.updated", { linkLabel: "Sequoia", values }, { kind: "user", name: "Owner" }));
    expect(u({ allowDownload: false })).toBe("Owner turned off downloads on link “Sequoia” on Deck");
    expect(u({ enabled: true })).toBe("Owner turned on link “Sequoia” on Deck");
    expect(u({ password: "set" })).toBe("Owner set a password on link “Sequoia” on Deck");
    expect(u({ allowDownload: true, enabled: false })).toBe("Owner changed settings of link “Sequoia” on Deck");
    // Rows written before `values` existed keep the old wording.
    expect(text(item("share_link.updated", { linkLabel: "Sequoia" }, { kind: "user", name: "Owner" }))).toBe("Owner updated link “Sequoia” on Deck");
  });

  test("archive and unarchive are labelled and filed under Documents", () => {
    expect(text(item("doc.archived", {}, { kind: "user", name: "Owner" }))).toBe("Owner archived Deck (its links stop working)");
    expect(text(item("doc.unarchived", {}, { kind: "user", name: "Owner" }))).toBe("Owner unarchived Deck");
    const docs = ACTIVITY_FILTERS.find((f) => f.id === "documents")!.types as readonly string[];
    expect(docs).toContain("doc.archived");
    expect(docs).toContain("doc.unarchived");
  });
});
