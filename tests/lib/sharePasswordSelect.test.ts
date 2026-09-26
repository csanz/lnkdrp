/**
 * The share-password fields are hidden from default reads, and hiding them did not open the gate.
 *
 * `ShareLink.password*` and the `Doc.sharePassword*` mirror are `select: false`, so a query that
 * does not ask for them never carries a hash out of the database. The hazard that comes with that is
 * fail-open: `shareLinkUnlocked` reads "no hash" as "no password", so a resolver that stopped
 * receiving the field would serve a locked document to anyone. This file pins both halves against the
 * **real** schemas, nothing mocked and nothing connected: the flag is on every field, a bare query
 * excludes them, the opt-in projections (`src/lib/share/passwordSelect.ts`) bring them back in every
 * shape the services use, and the real gate refuses a row that carries a hash.
 */
import { describe, expect, test } from "vitest";
import { Types, type ProjectionType, type Query } from "mongoose";

import { ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { DocModel } from "@/lib/models/Doc";
import {
  DOC_PASSWORD_FIELDS,
  SHARE_LINK_PASSWORD_FIELDS,
  WITH_DOC_PASSWORD,
  WITH_DOC_PASSWORD_HASH,
  WITH_LINK_PASSWORD,
  WITH_LINK_PASSWORD_PROJECTION,
} from "@/lib/share/passwordSelect";
import { shareLinkPasswordEnabled, shareLinkUnlocked } from "@/lib/share/links";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";

/**
 * The projection Mongoose will send, after it has applied the schema-level `select` flags. This is
 * the internal step `Query.exec` runs before the wire call, reached here so no database is needed.
 */
function wireProjection(query: Query<unknown, unknown>): Record<string, unknown> {
  const q = query as unknown as { _applyPaths(): void; _fields?: Record<string, unknown> };
  q._applyPaths();
  return q._fields ?? {};
}

/** Every field the projection sends as excluded (`0`). */
function excluded(projection: Record<string, unknown>): string[] {
  return Object.entries(projection)
    .filter(([, v]) => v === 0)
    .map(([k]) => k);
}

const SHARE_ID = "srDP4SzZNA5a";
const PASSWORD_HASH = "qN0tArEaLhAsH";
const PROTECTED = { passwordHash: PASSWORD_HASH, passwordSalt: "saltysalt" };

describe("schema: the password fields are select: false", () => {
  test.each(SHARE_LINK_PASSWORD_FIELDS)("ShareLink.%s", (field) => {
    const path = ShareLinkModel.schema.path(field) as { options?: { select?: unknown } } | undefined;
    expect(path, `${field} is not a schema path`).toBeTruthy();
    expect(path?.options?.select).toBe(false);
  });

  test.each(DOC_PASSWORD_FIELDS)("Doc.%s", (field) => {
    const path = DocModel.schema.path(field) as { options?: { select?: unknown } } | undefined;
    expect(path, `${field} is not a schema path`).toBeTruthy();
    expect(path?.options?.select).toBe(false);
  });

  test("the opt-in constants name exactly the flagged fields", () => {
    for (const f of SHARE_LINK_PASSWORD_FIELDS) {
      expect(WITH_LINK_PASSWORD).toContain(`+${f}`);
      expect(WITH_LINK_PASSWORD_PROJECTION[`+${f}`]).toBe(1);
    }
    for (const f of DOC_PASSWORD_FIELDS) expect(WITH_DOC_PASSWORD).toContain(`+${f}`);
    expect(WITH_DOC_PASSWORD_HASH).toBe("+sharePasswordHash");
  });
});

describe("ShareLink queries", () => {
  test("a bare findOne excludes every password field", () => {
    const projection = wireProjection(ShareLinkModel.findOne({ shareId: SHARE_ID }));
    expect(excluded(projection).sort()).toEqual([...SHARE_LINK_PASSWORD_FIELDS].sort());
  });

  test("a bare find, and a findOneAndUpdate with { new: true }, exclude them too", () => {
    expect(excluded(wireProjection(ShareLinkModel.find({ docId: new Types.ObjectId() })))).toContain("passwordHash");
    expect(
      excluded(wireProjection(ShareLinkModel.findOneAndUpdate({ shareId: SHARE_ID }, { $set: { label: "x" } }, { new: true }))),
    ).toContain("passwordHash");
  });

  test("the resolver shape, findOne(filter, WITH_LINK_PASSWORD), sends no exclusion", () => {
    const projection = wireProjection(ShareLinkModel.findOne({ shareId: SHARE_ID }, WITH_LINK_PASSWORD));
    expect(excluded(projection)).toEqual([]);
    // And it stays a whole-row read: `+field` opts in, it does not turn the projection inclusive.
    expect(Object.values(projection)).not.toContain(1);
  });

  test("the list and page shapes, find(filter, WITH_LINK_PASSWORD), send no exclusion", () => {
    const projection = wireProjection(ShareLinkModel.find({ docId: new Types.ObjectId() }, WITH_LINK_PASSWORD));
    expect(excluded(projection)).toEqual([]);
  });

  test("the text-search shape keeps its $meta score and sends no exclusion", () => {
    const projection = wireProjection(
      // Same cast the services use: Mongoose's projection typing has no slot for `$meta`.
      ShareLinkModel.find(
        { $text: { $search: "sequoia" } },
        { score: { $meta: "textScore" }, ...WITH_LINK_PASSWORD_PROJECTION } as unknown as ProjectionType<ShareLink>,
      ),
    );
    expect(projection.score).toEqual({ $meta: "textScore" });
    expect(excluded(projection)).toEqual([]);
  });

  test("the update shape, findOneAndUpdate with projection: WITH_LINK_PASSWORD, sends no exclusion", () => {
    const projection = wireProjection(
      ShareLinkModel.findOneAndUpdate({ shareId: SHARE_ID }, { $set: { label: "x" } }, { new: true, projection: WITH_LINK_PASSWORD }),
    );
    expect(excluded(projection)).toEqual([]);
  });

  test("an explicit inclusive projection that names the hash still gets it (the admin links route)", () => {
    const projection = wireProjection(ShareLinkModel.find({}).select({ label: 1, passwordHash: 1 }));
    expect(projection).toEqual({ label: 1, passwordHash: 1 });
  });
});

describe("Doc queries", () => {
  test("a bare findOne excludes the whole mirror", () => {
    const projection = wireProjection(DocModel.findOne({ _id: new Types.ObjectId() }));
    for (const f of DOC_PASSWORD_FIELDS) expect(projection[f]).toBe(0);
  });

  test("the service projection that names the fields (DOC_SHARE_FIELDS) keeps them", () => {
    const projection = wireProjection(
      DocModel.findOne({ _id: new Types.ObjectId() }).select({ _id: 1, shareId: 1, sharePasswordHash: 1, sharePasswordSalt: 1 }),
    );
    expect(projection.sharePasswordHash).toBe(1);
    expect(projection.sharePasswordSalt).toBe(1);
    expect(projection.sharePasswordEnc).toBeUndefined();
  });

  test("the owner routes' shape, findOne(filter, WITH_DOC_PASSWORD_HASH), sends no exclusion for the hash", () => {
    const projection = wireProjection(DocModel.findOne({ _id: new Types.ObjectId() }, WITH_DOC_PASSWORD_HASH));
    expect(projection.sharePasswordHash).toBeUndefined();
    // The salt and the decryptable copy stay hidden on a hash-only read.
    expect(projection.sharePasswordSalt).toBe(0);
    expect(projection.sharePasswordEnc).toBe(0);
  });

  test("findOneAndUpdate with projection: WITH_DOC_PASSWORD_HASH returns the hash on the updated row", () => {
    const projection = wireProjection(
      DocModel.findOneAndUpdate({ _id: new Types.ObjectId() }, { $set: { shareId: "x" } }, { new: true, projection: WITH_DOC_PASSWORD_HASH }),
    );
    expect(projection.sharePasswordHash).toBeUndefined();
  });
});

describe("the gate, against a row as the resolver now hands it back", () => {
  const req = (cookie?: string) => new Request("https://lnkdrp.test/x", { headers: cookie ? { cookie } : undefined });
  const cookie = () => `${shareAuthCookieName(SHARE_ID)}=${shareAuthCookieValue({ shareId: SHARE_ID, sharePasswordHash: PASSWORD_HASH })}`;

  test("a row with a hash and no cookie is refused", () => {
    expect(shareLinkPasswordEnabled(PROTECTED)).toBe(true);
    expect(shareLinkUnlocked(req(), SHARE_ID, PROTECTED)).toBe(false);
  });

  test("the same row with the unlock cookie is served", () => {
    expect(shareLinkUnlocked(req(cookie()), SHARE_ID, PROTECTED)).toBe(true);
  });

  test("the hazard the projection guards against: a row read without its fields passes as open", () => {
    // This is what a resolver that forgot `WITH_LINK_PASSWORD` would hand the gate, and why the
    // resolver tests beside this file assert on the projection itself.
    const stripped: Record<string, unknown> = { _id: new Types.ObjectId(), shareId: SHARE_ID, label: "Sequoia" };
    expect(shareLinkUnlocked(req(), SHARE_ID, stripped as { passwordHash?: string | null })).toBe(true);
  });
});
