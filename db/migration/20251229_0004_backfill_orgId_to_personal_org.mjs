/**
 * Backfill `orgId` to each user's Personal org for legacy records.
 *
 * Why:
 * - Org scoping requires `orgId` on core records.
 * - Existing data may predate orgs and only have `userId`.
 *
 * What this does (idempotent):
 * - Ensures every user has a non-deleted personal org (`orgs` doc with `type:"personal"`).
 * - Ensures an owner membership exists in `orgmemberships`.
 * - Sets `orgId` on:
 *   - projects (includes request repos)
 *   - docs
 *   - uploads
 *   where `orgId` is missing or null.
 *
 * Notes:
 * - Does NOT overwrite existing non-null `orgId` values.
 * - Does NOT move records between users.
 */
import { ObjectId } from "mongodb";

function now() {
  return new Date();
}

function isObjectId(v) {
  try {
    return Boolean(v && (v instanceof ObjectId || ObjectId.isValid(String(v))));
  } catch {
    return false;
  }
}

export async function up({ db }) {
  const users = db.collection("users");
  const orgs = db.collection("orgs");
  const memberships = db.collection("orgmemberships");

  const projects = db.collection("projects");
  const docs = db.collection("docs");
  const uploads = db.collection("uploads");

  // Iterate users (including temp users) to ensure personal org + backfill orgId for that user.
  const cursor = users.find({}, { projection: { _id: 1 } });
  // eslint-disable-next-line no-await-in-loop
  while (await cursor.hasNext()) {
    // eslint-disable-next-line no-await-in-loop
    const u = await cursor.next();
    const userId = u?._id;
    if (!isObjectId(userId)) continue;

    // 1) Ensure personal org exists.
    // eslint-disable-next-line no-await-in-loop
    let org = await orgs.findOne(
      { type: "personal", personalForUserId: userId, isDeleted: { $ne: true } },
      { projection: { _id: 1 } },
    );

    if (!org?._id) {
      const createdAt = now();
      const insert = {
        type: "personal",
        personalForUserId: userId,
        name: "Personal",
        slug: null,
        createdByUserId: userId,
        isDeleted: false,
        createdDate: createdAt,
        updatedDate: createdAt,
      };
      // eslint-disable-next-line no-await-in-loop
      const res = await orgs.insertOne(insert);
      org = { _id: res.insertedId };
    }

    const orgId = org._id;
    if (!isObjectId(orgId)) continue;

    // 2) Ensure membership exists (owner).
    // eslint-disable-next-line no-await-in-loop
    await memberships.updateOne(
      { orgId, userId },
      {
        $setOnInsert: {
          orgId,
          userId,
          role: "owner",
          isDeleted: false,
          createdDate: now(),
          updatedDate: now(),
        },
        $set: { isDeleted: false, updatedDate: now() },
      },
      { upsert: true },
    );

    // 3) Backfill orgId on core collections where missing/null.
    const missingOrg = { $or: [{ orgId: { $exists: false } }, { orgId: null }] };

    // eslint-disable-next-line no-await-in-loop
    await projects.updateMany({ userId, ...missingOrg }, { $set: { orgId } });
    // eslint-disable-next-line no-await-in-loop
    await docs.updateMany({ userId, ...missingOrg }, { $set: { orgId } });
    // eslint-disable-next-line no-await-in-loop
    await uploads.updateMany({ userId, ...missingOrg }, { $set: { orgId } });
  }
}




