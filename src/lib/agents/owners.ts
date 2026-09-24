/**
 * Who created a credential, for the Connect page's "by <name>" in shared workspaces.
 *
 * Its own module because both credential shapes need it: keys (`apiKeys.ts`) and OAuth grants
 * (`oauth.ts`), and `apiKeys.ts` lists grants beside keys, so the two cannot import each other.
 */
import { Types } from "mongoose";

import { UserModel } from "@/lib/models/User";

/** Owner display info resolved from `User` for `createdBy`. */
export type KeyOwner = { id: string; name: string | null; email: string | null };

/** Resolve creator ids to display info in one query (missing users map to null). */
export async function resolveOwners(ids: Array<Types.ObjectId | string | null | undefined>): Promise<Map<string, KeyOwner>> {
  const unique = Array.from(new Set(ids.filter(Boolean).map((v) => String(v)))).filter((v) => Types.ObjectId.isValid(v));
  const out = new Map<string, KeyOwner>();
  if (unique.length === 0) return out;
  const users = await UserModel.find({ _id: { $in: unique.map((v) => new Types.ObjectId(v)) } })
    .select({ name: 1, email: 1 })
    .lean();
  for (const u of users as Array<{ _id: Types.ObjectId; name?: string | null; email?: string | null }>) {
    out.set(String(u._id), { id: String(u._id), name: u.name ?? null, email: u.email ?? null });
  }
  return out;
}
