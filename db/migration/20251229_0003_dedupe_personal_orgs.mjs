/**
 * Dedupe personal orgs.
 *
 * Why:
 * - Personal orgs should be 1:1 per user (`personalForUserId`).
 * - Early org rollout or dev/test data can accidentally create duplicates.
 *
 * What this does (idempotent-ish):
 * - For each user with >1 personal org, keep one and soft-delete the others.
 * - Re-point `orgId` on projects/docs/uploads from duplicate orgs -> kept org.
 * - Move memberships from duplicate orgs -> kept org (and soft-delete the duplicate memberships).
 *
 * Notes:
 * - This does NOT delete documents; it only sets `isDeleted=true` on duplicate org rows.
 * - Safe to run multiple times; repeated runs should have no additional effect.
 */
import { ObjectId } from "mongodb";

function isObjectId(v) {
  try {
    return Boolean(v && (v instanceof ObjectId || ObjectId.isValid(String(v))));
  } catch {
    return false;
  }
}

export async function up({ db }) {
  const orgs = db.collection("orgs");
  const memberships = db.collection("orgmemberships");
  const projects = db.collection("projects");
  const docs = db.collection("docs");
  const uploads = db.collection("uploads");

  // Find users that have multiple non-deleted personal orgs.
  const dupes = await orgs
    .aggregate([
      { $match: { type: "personal", isDeleted: { $ne: true }, personalForUserId: { $type: "objectId" } } },
      {
        $group: {
          _id: "$personalForUserId",
          orgIds: { $push: "$_id" },
          count: { $sum: 1 },
          createdDates: { $push: "$createdDate" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  for (const row of dupes) {
    const userId = row?._id;
    const orgIds = Array.isArray(row?.orgIds) ? row.orgIds.filter(isObjectId).map((x) => new ObjectId(String(x))) : [];
    if (!userId || !orgIds.length) continue;

    // Keep the oldest by createdDate (fallback: lowest ObjectId).
    const candidates = await orgs
      .find({ _id: { $in: orgIds }, type: "personal", isDeleted: { $ne: true } }, { projection: { _id: 1, createdDate: 1 } })
      .toArray();
    if (!candidates.length) continue;

    candidates.sort((a, b) => {
      const ad = a?.createdDate instanceof Date ? a.createdDate.getTime() : 0;
      const bd = b?.createdDate instanceof Date ? b.createdDate.getTime() : 0;
      if (ad !== bd) return ad - bd;
      return String(a._id).localeCompare(String(b._id));
    });

    const keepOrgId = candidates[0]._id;
    const dropOrgIds = candidates.slice(1).map((c) => c._id);
    if (!dropOrgIds.length) continue;

    // Re-point tenant ids on primary collections.
    await projects.updateMany({ orgId: { $in: dropOrgIds } }, { $set: { orgId: keepOrgId } });
    await docs.updateMany({ orgId: { $in: dropOrgIds } }, { $set: { orgId: keepOrgId } });
    await uploads.updateMany({ orgId: { $in: dropOrgIds } }, { $set: { orgId: keepOrgId } });

    // Ensure membership exists for the kept org.
    await memberships.updateOne(
      { orgId: keepOrgId, userId, isDeleted: { $ne: true } },
      { $setOnInsert: { orgId: keepOrgId, userId, role: "owner", createdDate: new Date(), updatedDate: new Date(), isDeleted: false } },
      { upsert: true },
    );

    // Soft-delete duplicate org memberships (any role) for this user.
    await memberships.updateMany(
      { orgId: { $in: dropOrgIds }, userId, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedDate: new Date(), updatedDate: new Date() } },
    );

    // Soft-delete the duplicate orgs.
    await orgs.updateMany(
      { _id: { $in: dropOrgIds }, type: "personal", personalForUserId: userId, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedDate: new Date(), updatedDate: new Date() } },
    );
  }
}




