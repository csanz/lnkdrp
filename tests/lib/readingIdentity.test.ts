/**
 * Person ids and anonymous labels (spec §3.3, §3.8).
 */
import { describe, expect, test } from "vitest";

import { buildPeople, decodePersonId, encodePersonId } from "@/lib/analytics/reading";

import { T0, hex24, hex64, makeLink, makeRow } from "./fixtures/readingFixtures";

describe("person ids", () => {
  test("round trip anonymous and signed-in", () => {
    const a = { shareId: "abcD_12-x", kind: "a" as const, id: hex64("anon") };
    const u = { shareId: "abcD_12-x", kind: "u" as const, id: hex24("user") };
    expect(decodePersonId(encodePersonId(a))).toEqual(a);
    expect(decodePersonId(encodePersonId(u))).toEqual(u);
  });

  test("rejects emails, wrong lengths and bad share ids", () => {
    expect(decodePersonId("abcd1234.a.dana@example.test")).toBeNull();
    expect(decodePersonId(`abcd1234.a.${hex64("x").slice(0, 63)}`)).toBeNull();
    expect(decodePersonId(`abcd1234.u.${hex64("x")}`)).toBeNull();
    expect(decodePersonId(`ab.cd.a.${hex64("x")}`)).toBeNull();
    expect(decodePersonId(`abc.a.${hex64("x")}`)).toBeNull();
    expect(decodePersonId(`abcd1234.x.${hex64("x")}`)).toBeNull();
    expect(decodePersonId(`abcd1234.a.${hex64("x").toUpperCase()}`)).toBeNull();
    expect(decodePersonId(null)).toBeNull();
    expect(decodePersonId("")).toBeNull();
  });
});

describe("anonymous labels", () => {
  const link = makeLink({ shareId: "seqLink1", label: "Sequoia" });
  const anon = (name: string, created: number) =>
    makeRow({ shareId: link.shareId, botIdHash: hex64(name), createdDate: new Date(created), updatedDate: new Date(created + 1000) });

  test("single anonymous person on a link", () => {
    const { people } = buildPeople([anon("one", T0)], [], [link], 3, T0);
    expect(people[0].name).toBe("Anonymous reader · Sequoia");
    expect(people[0].source).toBe("anonymous");
    expect(people[0].email).toBeNull();
  });

  test("ordinals by first seen when two are anonymous on the link", () => {
    const later = anon("later", T0 + 5000);
    const earlier = anon("earlier", T0);
    const introduced = makeRow({
      shareId: link.shareId,
      botIdHash: hex64("intro"),
      viewerName: "Pat Grady",
      createdDate: new Date(T0 - 1000),
      updatedDate: new Date(T0),
    });
    const { people } = buildPeople([later, introduced, earlier], [], [link], 3, T0);
    const byBot = (name: string) => people.find((p) => p.key.endsWith(hex64(name)))!;
    expect(byBot("earlier").name).toBe("Anonymous reader 1 · Sequoia");
    expect(byBot("later").name).toBe("Anonymous reader 2 · Sequoia");
    expect(byBot("intro").name).toBe("Pat Grady");
    expect(byBot("intro").source).toBe("introduced");
  });

  test("person ids never contain an email", () => {
    const row = makeRow({
      shareId: link.shareId,
      botIdHash: hex64("mail"),
      viewerEmail: "dana@example.test",
      createdDate: new Date(T0),
      updatedDate: new Date(T0),
    });
    const { people } = buildPeople([row], [], [link], 3, T0);
    expect(people[0].personId).not.toContain("@");
    expect(decodePersonId(people[0].personId)).not.toBeNull();
  });
});
