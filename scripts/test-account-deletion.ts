/**
 * End-to-end check of account deletion, against the configured database and blob store.
 *
 * Creates a throwaway account with its own workspace, document, upload and a real stored file, then:
 *   1. asks for deletion through the same code the route uses (disable + reason + purge date),
 *   2. runs the purge as a dry run and prints what it would remove,
 *   3. brings the purge date forward and runs it for real,
 *   4. verifies the file is gone from the blob store and the rows are gone from the database.
 *
 * Everything it touches it created. Usage:
 *   npx tsx --env-file=.env.local scripts/test-account-deletion.ts [--keep]
 * `--keep` stops before the real purge, leaving the account in the disabled state so the UI and
 * /a/deletions can be looked at.
 */
import mongoose, { Types } from "mongoose";
import { put, head } from "@vercel/blob";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { purgeAfter } from "@/lib/accounts/deletion";
import { findAccountsDueForPurge, planPurge, purgeAccount } from "@/lib/accounts/purge";

const keep = process.argv.includes("--keep");
const stamp = Date.now().toString(36);
const EMAIL = `deletion-test-${stamp}@lnkdrp.invalid`;

function say(step: string, detail?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`\n▸ ${step}${detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function main() {
  await connectMongo();

  say("create a throwaway account", EMAIL);
  const user = await UserModel.create({
    email: EMAIL,
    name: "Deletion test",
    provider: "google",
    providerAccountId: `deletion-test-${stamp}`,
    isActive: true,
  });
  const org = await OrgModel.create({ type: "personal", name: "Deletion test", personalForUserId: user._id, createdByUserId: user._id });
  await OrgMembershipModel.create({ orgId: org._id, userId: user._id, role: "owner" });

  const blob = await put(`deletion-test/${stamp}.txt`, `throwaway file for ${EMAIL}`, { access: "public", addRandomSuffix: false });
  const doc = await DocModel.create({ orgId: org._id, userId: user._id, title: "Deletion test doc", status: "ready", isShared: true, shareId: `del-${stamp}` });
  await UploadModel.create({ orgId: org._id, userId: user._id, docId: doc._id, version: 1, status: "completed", blobUrl: blob.url, originalFileName: "throwaway.txt" });
  await ShareLinkModel.create({ orgId: org._id, docId: doc._id, shareId: `del-${stamp}`, label: "Deletion test link", createdByUserId: user._id, enabled: true });
  say("stored file", blob.url);

  say("ask for deletion (what POST /api/account/delete writes)");
  const requestedAt = new Date();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        isActive: false,
        deletionRequestedAt: requestedAt,
        deletionReasonCode: "temporary",
        deletionReasonText: "end-to-end test",
        deletionPurgeAfter: purgeAfter(requestedAt),
        deletionPurgedAt: null,
      },
    },
  );
  const disabled = (await UserModel.findById(user._id).select({ isActive: 1, deletionPurgeAfter: 1 }).lean()) as {
    isActive?: boolean;
    deletionPurgeAfter?: Date;
  } | null;
  say("account disabled", { isActive: disabled?.isActive, purgeAfter: disabled?.deletionPurgeAfter });

  const notYet = await findAccountsDueForPurge(new Date());
  say("due for purge today?", notYet.includes(String(user._id)) ? "YES (wrong: the grace period has not passed)" : "no, as expected");

  const plan = await planPurge(String(user._id));
  say("dry run", plan?.counts);
  const dry = await purgeAccount(String(user._id), { dryRun: true });
  say("dry run wrote nothing", { stillHasDoc: (await DocModel.countDocuments({ _id: doc._id })) === 1, blobsCounted: dry?.counts.blobs });

  if (keep) {
    say("--keep: stopping here", { userId: String(user._id), email: EMAIL });
    await mongoose.disconnect();
    return;
  }

  say("bring the purge date forward and run for real");
  await UserModel.updateOne({ _id: user._id }, { $set: { deletionPurgeAfter: new Date(Date.now() - 1000) } });
  const due = await findAccountsDueForPurge(new Date());
  if (!due.includes(String(user._id))) throw new Error("account should be due for purge");
  const result = await purgeAccount(String(user._id));
  say("purged", { blobsDeleted: result?.blobsDeleted, blobErrors: result?.blobErrors, counts: result?.counts });

  const checks = {
    docsGone: (await DocModel.countDocuments({ orgId: org._id })) === 0,
    uploadsGone: (await UploadModel.countDocuments({ orgId: org._id })) === 0,
    linksGone: (await ShareLinkModel.countDocuments({ orgId: org._id })) === 0,
    orgGone: (await OrgModel.countDocuments({ _id: org._id })) === 0,
    membershipGone: (await OrgMembershipModel.countDocuments({ userId: user._id })) === 0,
    fileGone: await head(blob.url).then(() => false).catch(() => true),
  };
  const tomb = (await UserModel.findById(user._id).select({ email: 1, name: 1, isActive: 1, deletionPurgedAt: 1 }).lean()) as
    | { email?: string; name?: string | null; isActive?: boolean; deletionPurgedAt?: Date | null }
    | null;
  say("after the purge", checks);
  say("tombstone left behind", tomb);

  // A real deletion keeps its tombstone; a test should not leave one lying in the users table.
  await UserModel.deleteOne({ _id: user._id });

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  // The tombstone must carry no identity: disabled, stamped, and the address replaced.
  const tombOk =
    tomb?.isActive === false &&
    Boolean(tomb?.deletionPurgedAt) &&
    tomb?.email === `deleted+${String(user._id)}@lnkdrp.invalid` &&
    !tomb?.name;
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.error(`\n✗ still present: ${failed.map(([k]) => k).join(", ")}`);
    process.exitCode = 1;
  } else if (!tombOk) {
    // eslint-disable-next-line no-console
    console.error("\n✗ the tombstone still carries identity", tomb);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log("\n✓ account, workspace, document, link and stored file are gone; only an anonymised tombstone remains");
  }
  await mongoose.disconnect();
}

void main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
  // Leave nothing behind when a step throws: a half-built test account was still an account, and it
  // showed up in the admin home's signup count until someone noticed.
  try {
    const stray = (await UserModel.find({ email: EMAIL }).select({ _id: 1 }).lean()) as Array<{ _id: unknown }>;
    for (const u of stray) await purgeAccount(String(u._id));
    await UserModel.deleteMany({ email: EMAIL });
    // eslint-disable-next-line no-console
    if (stray.length) console.error(`cleaned up the throwaway account (${EMAIL})`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`could not clean up ${EMAIL}; remove it by hand`);
  }
  await mongoose.disconnect().catch(() => undefined);
});
