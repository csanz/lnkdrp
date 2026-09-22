/**
 * Signing in after an anonymous upload must not lose the document.
 *
 * A temp visitor's document is stamped with the *temp user's* personal org, and `ensureDefaultLink`
 * publishes its share link in that same org. `claim-temp` used to migrate `userId` alone, so after
 * sign-in every owner-side query missed the row: `buildDocMatch` and the share-link helpers are all
 * org-scoped, and their legacy fallback only matches rows whose `orgId` is absent or null — never a
 * row carrying a non-null *temp* org.
 *
 * The result was the worst shape a bug can take here. The document disappeared from the dashboard
 * and could not be opened, edited, deleted or un-shared, while `resolveShareLink` matches on the
 * slug alone and kept serving the PDF to anyone holding the URL. The temp user row is deleted at
 * the end of the same handler, so nothing could reach those rows again: a permanent public link to
 * a private document, with no owner.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ROUTE = "src/app/api/auth/claim-temp/route.ts";

describe("claiming an anonymous session takes the workspace with it", () => {
  test("documents and uploads get the real owner's org, not just their user id", () => {
    const src = read(ROUTE);

    expect(src).toContain("ensurePersonalOrgForUserId({ userId: realUserId })");
    // Plain substring checks: the `s` regex flag needs a newer target than this tsconfig sets.
    expect(src).toContain("DocModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId, orgId: realOrgId } })");
    expect(src).toContain("UploadModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId, orgId: realOrgId } })");
  });

  test("share links follow their documents, matched by docId", () => {
    const src = read(ROUTE);

    // `ShareLink` has no `userId` field — it is keyed by `orgId` and `docId` — so matching links
    // by the temp user would compile, run, and silently update nothing.
    expect(src).toContain("ShareLinkModel.updateMany({ docId: { $in: movingDocIds } }");
    expect(src).not.toMatch(/ShareLinkModel\.updateMany\(\s*\{\s*userId:/);
  });

  test("the doc ids are read before the update, or there is nothing left to match on", () => {
    const src = read(ROUTE);

    const read_ = src.indexOf("const movingDocs");
    const update = src.indexOf("DocModel.updateMany");
    expect(read_).toBeGreaterThan(-1);
    expect(read_).toBeLessThan(update);
  });
});

describe("the model really has no userId to match on", () => {
  test("ShareLink is keyed by orgId and docId", () => {
    const model = read("src/lib/models/ShareLink.ts");

    expect(model).toMatch(/orgId: \{ type: Schema\.Types\.ObjectId/);
    expect(model).toMatch(/docId: \{ type: Schema\.Types\.ObjectId/);
    // The assertion that makes the test above meaningful rather than cosmetic.
    expect(model).not.toMatch(/^\s+userId:/m);
  });
});
