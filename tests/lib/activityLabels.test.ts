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

  /**
   * Who is in the workspace is the most consequential thing that happens in it — it changes who can
   * read every document — and the feed could not say any of it. The target is read out of `meta`
   * rather than the actor, because the person removed is not the person who removed them, and
   * because the sentence has to survive that account being deleted later.
   */
  test("membership changes read as sentences about the person, not the row", () => {
    const owner = { kind: "user", name: "Owner" } as const;
    expect(text(item("member.invited", { email: "new@example.com", role: "member" }, owner))).toBe("Owner invited new@example.com");
    expect(text(item("member.invited", { email: "new@example.com", role: "admin" }, owner))).toBe("Owner invited new@example.com as admin");
    // A link invite names nobody: it is a door held open, not a letter sent.
    expect(text(item("member.invited", { role: "member", via: "link" }, owner))).toBe("Owner invited someone");
    expect(text(item("member.joined", { email: "new@example.com", role: "member" }, { kind: "user", name: "New Person" }))).toBe(
      "New Person joined this workspace",
    );
    // The person who joined named by their address when the event predates their profile name.
    expect(text(item("member.joined", { email: "new@example.com", role: "viewer" }))).toBe("new@example.com joined this workspace as viewer");
    expect(text(item("member.removed", { name: "Ex Person", email: "ex@example.com" }, owner))).toBe(
      "Owner removed Ex Person from this workspace",
    );
    // No name recorded: the address, never a blank or the remover's own name.
    expect(text(item("member.removed", { email: "ex@example.com" }, owner))).toBe("Owner removed ex@example.com from this workspace");
    expect(text(item("member.left", {}, { kind: "user", name: "Ex Person" }))).toBe("Ex Person left this workspace");

    const members = ACTIVITY_FILTERS.find((f) => f.id === "members")!.types as readonly string[];
    expect([...members].sort()).toEqual(["member.invited", "member.joined", "member.left", "member.removed"]);
  });

  /**
   * A data room's distinguishing case is the visitor who opens it and reads nothing: they write no
   * ShareView row, so the one arrival a sender most wants to know about was the one the feed could
   * not mention. It is filed under Views, not Members — it is a recipient, not work done here.
   */
  test("landing on a project link names the room, not a document", () => {
    const landing = {
      ...item("project.landed", { viewerName: "Michael J", linkLabel: "Default link", isDefaultLink: true }),
      doc: null,
      project: { id: "p1", name: "Data room" },
    } as ActivityItem;
    expect(text(landing)).toBe("Michael J opened Data room");

    // The project row is gone (deleted): the name recorded at the time still carries the sentence.
    const orphan = { ...landing, project: null, meta: { ...landing.meta, projectName: "Data room" } } as ActivityItem;
    expect(text(orphan)).toBe("Michael J opened Data room");

    // A named link says which door they came through; the default link is not a name.
    const viaNamed = { ...landing, meta: { viewerName: "Michael J", linkLabel: "Sequoia" } } as ActivityItem;
    expect(text(viaNamed)).toBe("Michael J opened Data room via Sequoia");

    expect(ACTIVITY_FILTERS.find((f) => f.id === "views")!.types as readonly string[]).toContain("project.landed");
  });

  /**
   * A project link hangs off a project, not a document, so every sentence that names what a link
   * belongs to has to ask `linkOwnerLabel`. Three did and three did not, and revealing a data
   * room's password read as "… on Untitled document" — a document that does not exist, named in a
   * sentence about a project.
   */
  test("a project link's sentences name the project, never “Untitled document”", () => {
    const owner = { kind: "user", name: "Owner" } as const;
    const onProject = (type: string, meta: Record<string, unknown> = {}): ActivityItem =>
      ({ ...item(type, { projectName: "Lite Data Room", ...meta }, owner), doc: null, project: { id: "p1", name: "Lite Data Room" } }) as ActivityItem;

    expect(text(onProject("share_link.password_revealed", { linkLabel: "Accel · locked" }))).toBe(
      "Owner viewed the password for “Accel · locked” on project Lite Data Room",
    );
    expect(text(onProject("share.password_set"))).toBe("Owner set a password on project Lite Data Room");
    expect(text(onProject("share.password_cleared"))).toBe("Owner removed the password from project Lite Data Room");
    expect(text(onProject("share_link.created", { linkLabel: "Accel · locked" }))).toBe(
      "Owner created a link “Accel · locked” for project Lite Data Room",
    );

    // The project row is gone: the name recorded at the time still carries the sentence.
    const orphan = { ...onProject("share_link.password_revealed", { linkLabel: "Accel" }), project: null } as ActivityItem;
    expect(text(orphan)).toBe("Owner viewed the password for “Accel” on project Lite Data Room");

    // A document link is untouched by all of this.
    expect(text(item("share_link.password_revealed", { linkLabel: "Sequoia" }, owner))).toBe(
      "Owner viewed the password for “Sequoia” on Deck",
    );
  });

  /**
   * An introduction stays named on Free, unlike every other recipient event: the name was
   * volunteered *to* this workspace, so hiding it behind the Pro identity gate would be hiding a
   * message its sender meant them to have.
   */
  test("an introduction names the person and says where", () => {
    const inRoom = (meta: Record<string, unknown>): ActivityItem =>
      ({ ...item("viewer.introduced", meta), doc: null, project: { id: "p1", name: "Lite Data Room" } }) as ActivityItem;

    expect(text(inRoom({ viewerName: "John J", viewerEmail: "john@example.com" }))).toBe(
      "John J introduced themselves on Lite Data Room john@example.com",
    );
    // A correction reads differently: same contact, fixing what we had.
    expect(text(inRoom({ viewerName: "John Jay", viewerEmail: "john@example.com", changed: true }))).toBe(
      "John Jay updated who they are on Lite Data Room john@example.com",
    );
    // Email only: it is the name and the address, so it is not repeated.
    expect(text(inRoom({ viewerEmail: "john@example.com" }))).toBe(
      "john@example.com introduced themselves on Lite Data Room",
    );
    // On a document link the object is the document.
    expect(text(item("viewer.introduced", { viewerName: "John J" }))).toBe("John J introduced themselves on Deck");

    expect(ACTIVITY_FILTERS.find((f) => f.id === "views")!.types as readonly string[]).toContain("viewer.introduced");
    // A recipient getting past a password is a recipient's action, so it sits with the rest of
    // their visit — and is therefore excluded from the donut, whose denominator is work done here.
    expect(ACTIVITY_FILTERS.find((f) => f.id === "views")!.types as readonly string[]).toContain("share.unlocked");
    expect(ACTIVITY_FILTERS.find((f) => f.id === "sharing")!.types as readonly string[]).not.toContain("share.unlocked");
  });

  test("archive and unarchive are labelled and filed under Documents", () => {
    expect(text(item("doc.archived", {}, { kind: "user", name: "Owner" }))).toBe("Owner archived Deck (its links stop working)");
    expect(text(item("doc.unarchived", {}, { kind: "user", name: "Owner" }))).toBe("Owner unarchived Deck");
    const docs = ACTIVITY_FILTERS.find((f) => f.id === "documents")!.types as readonly string[];
    expect(docs).toContain("doc.archived");
    expect(docs).toContain("doc.unarchived");
  });
});
