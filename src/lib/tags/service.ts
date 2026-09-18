/**
 * Tag service: create, attach, detach, rename, merge, list — everything that writes a tag.
 *
 * Routes stay thin on purpose. The rules that keep a tag list usable after a year live here:
 * one tag per folded name per workspace, attach is idempotent, rename is one write, merge moves
 * assignments and drops the duplicates it would have created, and every read is bounded by
 * `orgId` so a tag can never be seen or attached across workspaces.
 *
 * Pure helpers (folding, palette) are in `./slug` and `./palette`, which import nothing, so the
 * client-side input and this module agree on what makes two tags the same tag.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { TagModel, type Tag } from "@/lib/models/Tag";
import { TagAssignmentModel, type TagTargetKind } from "@/lib/models/TagAssignment";
import { asTagColorKey, nextTagColor, type TagColorKey, TAG_COLOR_KEYS } from "./palette";
import { isUsableTagName, normalizeTagName, tagSlug } from "./slug";

/** A tag as every surface reads it: never the raw document. */
export type TagDTO = {
  id: string;
  name: string;
  slug: string;
  color: TagColorKey;
  /** How many things carry it, when the caller asked for counts. */
  count?: number;
};

export function toTagDTO(tag: Pick<Tag, "_id" | "name" | "slug" | "color">, count?: number): TagDTO {
  return {
    id: String(tag._id),
    name: String(tag.name ?? ""),
    slug: String(tag.slug ?? ""),
    color: asTagColorKey(tag.color),
    ...(typeof count === "number" ? { count } : {}),
  };
}

function orgObjectId(orgId: string | Types.ObjectId): Types.ObjectId {
  return typeof orgId === "string" ? new Types.ObjectId(orgId) : orgId;
}

/**
 * Find a tag by typed name, or create it.
 *
 * The folded name is the identity, so "Fundraising" typed where "fundraising" exists returns the
 * existing tag rather than a second one — and the display name of the existing tag wins, because
 * renaming by re-typing a name in a different case would surprise everyone else in the workspace.
 */
export async function findOrCreateTag(params: {
  orgId: string | Types.ObjectId;
  name: string;
  userId?: string | Types.ObjectId | null;
  color?: TagColorKey;
}): Promise<{ tag: TagDTO; created: boolean }> {
  const name = normalizeTagName(params.name);
  const slug = tagSlug(name);
  if (!slug) throw new Error("A tag needs at least one letter or number");

  await connectMongo();
  const orgId = orgObjectId(params.orgId);

  const existing = await TagModel.findOne({ orgId, slug }).lean();
  if (existing) return { tag: toTagDTO(existing as Tag), created: false };

  const color = params.color ?? (await pickColorForWorkspace(orgId));
  try {
    const created = await TagModel.create({
      orgId,
      name,
      slug,
      color,
      createdByUserId: params.userId ? new Types.ObjectId(String(params.userId)) : null,
    });
    return { tag: toTagDTO(created), created: true };
  } catch (err) {
    // Two people typing the same new tag at once is a race the unique index settles; the loser
    // reads the winner's row rather than failing the action the person actually asked for.
    const duplicate = (err as { code?: number } | null)?.code === 11000;
    if (!duplicate) throw err;
    const raced = await TagModel.findOne({ orgId, slug }).lean();
    if (!raced) throw err;
    return { tag: toTagDTO(raced as Tag), created: false };
  }
}

/** The least-used palette colour in this workspace, so early tags never collide. */
async function pickColorForWorkspace(orgId: Types.ObjectId): Promise<TagColorKey> {
  const rows = (await TagModel.aggregate([
    { $match: { orgId } },
    { $group: { _id: "$color", n: { $sum: 1 } } },
  ])) as Array<{ _id?: unknown; n?: unknown }>;
  const used: Partial<Record<TagColorKey, number>> = {};
  for (const row of rows) {
    const key = asTagColorKey(row?._id);
    used[key] = (used[key] ?? 0) + (typeof row?.n === "number" ? row.n : 0);
  }
  return nextTagColor(used);
}

/** Every tag in the workspace, alphabetical, with how many things carry each. */
export async function listTags(params: {
  orgId: string | Types.ObjectId;
  withCounts?: boolean;
}): Promise<TagDTO[]> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tags = (await TagModel.find({ orgId }).sort({ name: 1 }).lean()) as Tag[];
  if (!params.withCounts || !tags.length) return tags.map((t) => toTagDTO(t));

  const counts = (await TagAssignmentModel.aggregate([
    { $match: { orgId, tagId: { $in: tags.map((t) => t._id) } } },
    { $group: { _id: "$tagId", n: { $sum: 1 } } },
  ])) as Array<{ _id?: Types.ObjectId; n?: number }>;
  const byId = new Map(counts.map((c) => [String(c._id), Math.max(0, Number(c.n ?? 0))]));
  return tags.map((t) => toTagDTO(t, byId.get(String(t._id)) ?? 0));
}

/** The tags on one document or project, in the order a chip row should print them. */
export async function tagsForTarget(params: {
  orgId: string | Types.ObjectId;
  targetKind: TagTargetKind;
  targetId: string | Types.ObjectId;
}): Promise<TagDTO[]> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const targetId = typeof params.targetId === "string" ? new Types.ObjectId(params.targetId) : params.targetId;
  const rows = (await TagAssignmentModel.find({ orgId, targetKind: params.targetKind, targetId })
    .select({ tagId: 1 })
    .lean()) as Array<{ tagId?: Types.ObjectId }>;
  if (!rows.length) return [];
  const tags = (await TagModel.find({ orgId, _id: { $in: rows.map((r) => r.tagId).filter(Boolean) } })
    .sort({ name: 1 })
    .lean()) as Tag[];
  return tags.map((t) => toTagDTO(t));
}

/** The tags on many targets at once, for a list that prints chips per row. */
export async function tagsForTargets(params: {
  orgId: string | Types.ObjectId;
  targetKind: TagTargetKind;
  targetIds: ReadonlyArray<string | Types.ObjectId>;
}): Promise<Map<string, TagDTO[]>> {
  const out = new Map<string, TagDTO[]>();
  if (!params.targetIds.length) return out;
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const ids = params.targetIds.map((id) => (typeof id === "string" ? new Types.ObjectId(id) : id));
  const rows = (await TagAssignmentModel.find({ orgId, targetKind: params.targetKind, targetId: { $in: ids } })
    .select({ tagId: 1, targetId: 1 })
    .lean()) as Array<{ tagId?: Types.ObjectId; targetId?: Types.ObjectId }>;
  if (!rows.length) return out;
  const tags = (await TagModel.find({ orgId, _id: { $in: [...new Set(rows.map((r) => String(r.tagId)))].map((s) => new Types.ObjectId(s)) } })
    .sort({ name: 1 })
    .lean()) as Tag[];
  const byId = new Map(tags.map((t) => [String(t._id), toTagDTO(t)]));
  for (const row of rows) {
    const dto = byId.get(String(row.tagId));
    if (!dto) continue;
    const key = String(row.targetId);
    out.set(key, [...(out.get(key) ?? []), dto]);
  }
  for (const [key, list] of out) out.set(key, list.sort((a, b) => a.name.localeCompare(b.name)));
  return out;
}

/** Put a tag on a document or project. Idempotent: tagging twice is the same fact, not two rows. */
export async function attachTag(params: {
  orgId: string | Types.ObjectId;
  tagId: string | Types.ObjectId;
  targetKind: TagTargetKind;
  targetId: string | Types.ObjectId;
  userId?: string | Types.ObjectId | null;
}): Promise<void> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tagId = typeof params.tagId === "string" ? new Types.ObjectId(params.tagId) : params.tagId;
  // Scoped read first: a tag id from another workspace must not become an assignment in this one.
  const tag = await TagModel.findOne({ _id: tagId, orgId }).select({ _id: 1 }).lean();
  if (!tag) throw new Error("Tag not found");
  const targetId = typeof params.targetId === "string" ? new Types.ObjectId(params.targetId) : params.targetId;
  await TagAssignmentModel.updateOne(
    { tagId, targetKind: params.targetKind, targetId },
    {
      $setOnInsert: {
        orgId,
        tagId,
        targetKind: params.targetKind,
        targetId,
        createdByUserId: params.userId ? new Types.ObjectId(String(params.userId)) : null,
      },
    },
    { upsert: true },
  );
}

/** Take a tag off a document or project. Removing one that is not there is not an error. */
export async function detachTag(params: {
  orgId: string | Types.ObjectId;
  tagId: string | Types.ObjectId;
  targetKind: TagTargetKind;
  targetId: string | Types.ObjectId;
}): Promise<void> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tagId = typeof params.tagId === "string" ? new Types.ObjectId(params.tagId) : params.tagId;
  const targetId = typeof params.targetId === "string" ? new Types.ObjectId(params.targetId) : params.targetId;
  await TagAssignmentModel.deleteOne({ orgId, tagId, targetKind: params.targetKind, targetId });
}

/** Rename a tag, or recolour it. One write: nothing else stores the name. */
export async function updateTag(params: {
  orgId: string | Types.ObjectId;
  tagId: string | Types.ObjectId;
  name?: string;
  color?: TagColorKey;
}): Promise<TagDTO> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tagId = typeof params.tagId === "string" ? new Types.ObjectId(params.tagId) : params.tagId;
  const update: Record<string, unknown> = {};

  if (typeof params.name === "string") {
    const name = normalizeTagName(params.name);
    if (!isUsableTagName(name)) throw new Error("A tag needs at least one letter or number");
    const slug = tagSlug(name);
    const clash = await TagModel.findOne({ orgId, slug, _id: { $ne: tagId } }).select({ _id: 1 }).lean();
    // Renaming onto an existing tag is a merge, and merging silently would destroy the distinction
    // between them without asking. The caller is told to merge instead.
    if (clash) throw new Error("A tag with that name already exists — merge them instead");
    update.name = name;
    update.slug = slug;
  }
  if (params.color && (TAG_COLOR_KEYS as readonly string[]).includes(params.color)) update.color = params.color;
  if (!Object.keys(update).length) throw new Error("Nothing to update");

  const updated = await TagModel.findOneAndUpdate({ _id: tagId, orgId }, { $set: update }, { new: true }).lean();
  if (!updated) throw new Error("Tag not found");
  return toTagDTO(updated as Tag);
}

/**
 * Merge `fromTagId` into `intoTagId`: every assignment moves, duplicates collapse, the source goes.
 *
 * Done as move-then-sweep rather than a transaction: a document carrying both tags would violate
 * the unique index on the move, so those rows are deleted first and the rest are re-pointed. The
 * worst interruption leaves assignments on the target, which is what a merge means.
 */
export async function mergeTags(params: {
  orgId: string | Types.ObjectId;
  fromTagId: string | Types.ObjectId;
  intoTagId: string | Types.ObjectId;
}): Promise<{ moved: number; collapsed: number }> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const fromId = typeof params.fromTagId === "string" ? new Types.ObjectId(params.fromTagId) : params.fromTagId;
  const intoId = typeof params.intoTagId === "string" ? new Types.ObjectId(params.intoTagId) : params.intoTagId;
  if (String(fromId) === String(intoId)) throw new Error("A tag cannot be merged into itself");

  const [from, into] = await Promise.all([
    TagModel.findOne({ _id: fromId, orgId }).select({ _id: 1 }).lean(),
    TagModel.findOne({ _id: intoId, orgId }).select({ _id: 1 }).lean(),
  ]);
  if (!from || !into) throw new Error("Tag not found");

  const targets = (await TagAssignmentModel.find({ orgId, tagId: intoId })
    .select({ targetKind: 1, targetId: 1 })
    .lean()) as Array<{ targetKind?: string; targetId?: Types.ObjectId }>;
  const alreadyThere = new Set(targets.map((t) => `${t.targetKind}:${String(t.targetId)}`));

  const moving = (await TagAssignmentModel.find({ orgId, tagId: fromId })
    .select({ _id: 1, targetKind: 1, targetId: 1 })
    .lean()) as Array<{ _id: Types.ObjectId; targetKind?: string; targetId?: Types.ObjectId }>;
  const duplicateIds = moving
    .filter((m) => alreadyThere.has(`${m.targetKind}:${String(m.targetId)}`))
    .map((m) => m._id);

  if (duplicateIds.length) await TagAssignmentModel.deleteMany({ _id: { $in: duplicateIds } });
  const moved = await TagAssignmentModel.updateMany({ orgId, tagId: fromId }, { $set: { tagId: intoId } });
  await TagModel.deleteOne({ _id: fromId, orgId });

  return { moved: moved.modifiedCount ?? 0, collapsed: duplicateIds.length };
}

/** Delete a tag and every assignment of it. The documents and projects themselves are untouched. */
export async function deleteTag(params: { orgId: string | Types.ObjectId; tagId: string | Types.ObjectId }): Promise<void> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tagId = typeof params.tagId === "string" ? new Types.ObjectId(params.tagId) : params.tagId;
  await TagAssignmentModel.deleteMany({ orgId, tagId });
  await TagModel.deleteOne({ _id: tagId, orgId });
}

/** What carries a tag: the ids, split by kind, for the tag page and the metrics rollup. */
export async function targetsForTag(params: {
  orgId: string | Types.ObjectId;
  tagId: string | Types.ObjectId;
}): Promise<{ docIds: string[]; projectIds: string[] }> {
  await connectMongo();
  const orgId = orgObjectId(params.orgId);
  const tagId = typeof params.tagId === "string" ? new Types.ObjectId(params.tagId) : params.tagId;
  const rows = (await TagAssignmentModel.find({ orgId, tagId })
    .select({ targetKind: 1, targetId: 1 })
    .lean()) as Array<{ targetKind?: string; targetId?: Types.ObjectId }>;
  const docIds: string[] = [];
  const projectIds: string[] = [];
  for (const row of rows) {
    if (!row?.targetId) continue;
    if (row.targetKind === "doc") docIds.push(String(row.targetId));
    else if (row.targetKind === "project") projectIds.push(String(row.targetId));
  }
  return { docIds, projectIds };
}
