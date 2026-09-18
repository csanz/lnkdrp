/**
 * The `shareId` bound on the two analytics routes, and the two bugs it was written to make
 * impossible (`src/lib/analytics/shareViewAggregates.ts`).
 *
 * Both were the same mistake and neither raised anything: a `$match` built by spreading a scope
 * object that already pins `shareId`, then adding a second `shareId` key beside it. The later key
 * replaces the earlier one, so the aggregate runs with *fewer* bounds than the code reads as having
 * — and an aggregate with fewer bounds returns more rows, confidently.
 *
 * - `/api/projects/:id/shareviews?shareIds=`: `projectScopeMatch`'s `$in` was the route's only
 *   tenancy clause, so a caller naming any slug got that link's traffic back, from any workspace,
 *   at `viewer` role.
 * - `/api/docs/:id/shareviews`: the deleted-link diff dropped the project-link exclusion, so a live
 *   project link was reported as one of the document's deleted links.
 */
import { describe, expect, test } from "vitest";

import { intersectShareIds, shareIdClause } from "@/lib/analytics/shareViewAggregates";

const PROJECT_SLUGS = ["4XX8hbn291OC", "jPaOy2VcGD5R", "cX92Zo5gEsoi"];

describe("intersectShareIds", () => {
  test("a foreign slug in the request yields no row", () => {
    // The exact live reproduction: two document links of another workspace, named in `?shareIds=`
    // on a project route. Before the fix both came back with full traffic.
    expect(intersectShareIds(PROJECT_SLUGS, ["PkKgq22XDWBg", "emkU2FjVhVVd"])).toEqual([]);
  });

  test("a mix keeps only the slugs the scope owns", () => {
    expect(intersectShareIds(PROJECT_SLUGS, ["PkKgq22XDWBg", "jPaOy2VcGD5R"])).toEqual(["jPaOy2VcGD5R"]);
  });

  test("it never widens: an unknown allow-list yields nothing, whatever is asked for", () => {
    expect(intersectShareIds([], ["jPaOy2VcGD5R"])).toEqual([]);
  });

  test("the result is ordered by the allow-list, not by the caller's input", () => {
    expect(intersectShareIds(PROJECT_SLUGS, ["cX92Zo5gEsoi", "4XX8hbn291OC"])).toEqual(["4XX8hbn291OC", "cX92Zo5gEsoi"]);
  });
});

describe("shareIdClause", () => {
  test("both bounds land on one key, so neither can replace the other", () => {
    const clause = shareIdClause({ only: ["a", "b", "c"], except: ["b"] });
    expect(clause).toEqual({ shareId: { $in: ["a", "b", "c"], $nin: ["b"] } });
    expect(Object.keys(clause)).toEqual(["shareId"]);
  });

  test("spreading it into a scope match replaces that scope's own `shareId`, never half of it", () => {
    // What the routes actually write. The point of the helper is that the caller cannot end up
    // with a `$in` where it meant `$in` **and** `$nin`.
    const scope = { docId: "doc1", isOwnerPreview: { $ne: true } };
    expect({ ...scope, ...shareIdClause({ except: ["proj1", "proj2"] }) }).toEqual({
      docId: "doc1",
      isOwnerPreview: { $ne: true },
      shareId: { $nin: ["proj1", "proj2"] },
    });
  });

  test("nothing to bound is an empty object, so it is always safe to spread", () => {
    expect(shareIdClause({})).toEqual({});
    expect(shareIdClause({ except: [] })).toEqual({});
    expect(shareIdClause({ only: null, except: null })).toEqual({});
  });

  test("an empty allow-list still bounds — it means 'nothing', not 'everything'", () => {
    // The difference between "the caller named only foreign slugs" and "the caller named none".
    // Dropping the clause here is precisely the leak `intersectShareIds` exists to prevent.
    expect(shareIdClause({ only: [] })).toEqual({ shareId: { $in: [] } });
  });

  test("it copies its inputs, so a later push to the caller's array cannot widen a built match", () => {
    const allowed = ["a"];
    const clause = shareIdClause({ only: allowed }) as { shareId: { $in: string[] } };
    allowed.push("b");
    expect(clause.shareId.$in).toEqual(["a"]);
  });
});
