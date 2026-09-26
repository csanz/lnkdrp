/**
 * The indexes locked projects need, created before anything can be locked
 * (docs/prds/lnkdrp-locked-projects.md, decision 30).
 *
 * This migration writes NO documents. `visibility` absent reads as `"workspace"`, exactly as
 * `Doc.visibility`'s default did when containment shipped, so every existing project stays open and
 * every existing document stays where it is. There is deliberately no backfill seating current
 * members as grantees: that would write one row per member per project across every workspace just
 * to express the default, and the absence of grants means nothing until a row is locked. Dropping
 * the code leaves the fields inert, which is what makes M1 rollback-safe.
 *
 * Four indexes:
 *
 * - The three on `projectmemberships` from decision 3. `{ projectId, userId }` unique, because one
 *   person holds at most one grant per room and a re-add revives the row rather than inserting a
 *   second. `{ orgId, userId, isDeleted }` for the question every filtered request asks ("which
 *   locked rooms may this person see"). `{ orgId, projectId, isDeleted }` for the room's roster.
 * - `{ orgId, visibility, updatedDate, _id }` on `projects`, so the list query that
 *   `20260121_0001_projects_list_indexes.mjs` documents keeps an index now that the visibility `$or`
 *   is in it. Mongo plans each `$or` branch separately, so the `visibility: { $ne: "locked" }`
 *   branch uses this one and the `_id: { $in: grants }` branch uses the `_id` index; without this,
 *   the first branch would fall back to the existing `{ orgId, updatedDate, _id }` and re-sort.
 *
 * `ensureIndex` is the idempotent helper from `20260121_0001_projects_list_indexes.mjs`, copied
 * rather than imported for the same reason every other migration copies it: a migration has to keep
 * working exactly as written on the day it ran, and a shared helper that changes later rewrites
 * history.
 */
export async function up({ db }) {
  async function ensureIndex(coll, key, options) {
    const name = options?.name;
    const wantPartial = options?.partialFilterExpression ?? null;
    const indexes = await coll.indexes().catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e))); // fresh DB: collection may not exist yet
    const existing = name ? indexes.find((i) => i?.name === name) : null;
    if (existing) {
      const sameKey = JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null);
      const havePartial = existing.partialFilterExpression ?? null;
      const samePartial = JSON.stringify(havePartial) === JSON.stringify(wantPartial);
      if (!sameKey || !samePartial) {
        await coll.dropIndex(existing.name);
      } else {
        return; // already correct
      }
    }
    await coll.createIndex(key, options);
  }

  const grants = db.collection("projectmemberships");

  // One grant per person per room.
  await ensureIndex(grants, { projectId: 1, userId: 1 }, { name: "projectId_1_userId_1", unique: true });
  // "Which locked rooms may this person see?" — read on every filtered request, `_id`-projected.
  await ensureIndex(grants, { orgId: 1, userId: 1, isDeleted: 1 }, { name: "orgId_1_userId_1_isDeleted_1" });
  // The roster for one room: the members panel, and the notification audience.
  await ensureIndex(grants, { orgId: 1, projectId: 1, isDeleted: 1 }, { name: "orgId_1_projectId_1_isDeleted_1" });

  const projects = db.collection("projects");

  // The org-scoped listing, now that the visibility clause is part of it.
  await ensureIndex(
    projects,
    { orgId: 1, visibility: 1, updatedDate: -1, _id: -1 },
    { name: "orgId_1_visibility_1_updatedDate_-1__id_-1" },
  );
}
