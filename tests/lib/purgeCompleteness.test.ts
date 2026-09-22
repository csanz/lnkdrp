/**
 * What survives an account deletion.
 *
 * Two gaps, both of the shape that shows up in a data-subject request rather than a bug report.
 *
 * **Collections keyed to a document or a project, not a workspace.** `AiRun` holds the prompts sent
 * and the model's replies; `ShareDownloadRequest` holds the email addresses of people who asked to
 * download — other people's personal data, kept after the owner asked to be forgotten. None of them
 * carries an `orgId`, so the workspace sweep could never have matched them however complete its
 * list of models became.
 *
 * **Rows that predate `orgId`.** A document created before workspaces existed has `orgId: null` and
 * only a `userId`. The org-scoped sweep matched none of them, so the PDF and every page image
 * stayed in blob storage and `/s/<shareId>` kept serving to anyone with the URL — while the account
 * reported as fully purged. The legacy *read* paths honour those rows (`allowLegacyByUserId`), so
 * the delete path has to as well, or deletion means less than reading does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const purge = readFileSync(join(ROOT, "src/lib/accounts/purge.ts"), "utf8");

describe("every model that holds user data is deleted", () => {
  /**
   * Infra and global collections, which belong to no account.
   *
   * `User` is the deliberate exception: the row survives as an anonymised tombstone because every
   * signed-in request reads it to end the session, and a token whose user vanished would be
   * treated as a stranger and mint a fresh workspace.
   */
  const NOT_PER_ACCOUNT = new Set(["BillingConfig", "CronHealth", "RateLimit", "StripeEvent", "User"]);

  const models = readdirSync(join(ROOT, "src/lib/models"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .filter((m) => !NOT_PER_ACCOUNT.has(m));

  test.each(models)("%s is purged", (model) => {
    expect(purge).toContain(`${model}Model.deleteMany`);
  });
});

describe("rows that predate workspaces are purged too", () => {
  test("documents and uploads are matched by owner as well as by org", () => {
    // The exact legacy shape `buildDocMatch` uses on the read side.
    expect(purge).toContain("const legacyOwned = { userId: id, $or: [{ orgId: { $exists: false } }, { orgId: null }] }");
    expect(purge).toContain("DocModel.deleteMany(ownedDocFilter)");
    expect(purge).toContain("UploadModel.deleteMany(ownedDocFilter)");
  });

  test("the blob pass sees them, or the files outlive the rows", () => {
    // Deleting the row without the blob leaves the PDF and every page image in storage.
    expect(purge).toContain("UploadModel.find({ $or: [{ orgId: { $in: soloOrgIds } }, legacyOwned] })");
  });

  test("a legacy document's share link goes with it", () => {
    // ShareLink always carries an org, so a legacy doc's link is only reachable through docId.
    expect(purge).toMatch(/ShareLinkModel\.deleteMany\(\{ \$or: \[orgFilter/);
  });
});

describe("dependent ids are read before the rows that carry them are deleted", () => {
  test("docIds and projectIds are collected first", () => {
    const collect = purge.indexOf("const [docRows, projectRows]");
    const destroy = purge.indexOf("DocModel.deleteMany(ownedDocFilter)");

    expect(collect).toBeGreaterThan(-1);
    // After the delete there is nothing left linking those dependents to this account: they would
    // be retained for ever, invisible to the product, and reported as purged.
    expect(collect).toBeLessThan(destroy);
  });
});
