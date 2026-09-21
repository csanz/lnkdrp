/**
 * Who a recipient is being shown something *by*.
 *
 * Every recipient-facing page — the data room, the document viewer, the password gate — was
 * unsigned: a black page with our paper plane in the corner and the sender's own deck underneath
 * it. The reader had the document but not the sender, and the one place the sender's identity was
 * guaranteed to be was inside the PDF, which is exactly where it cannot be seen before opening it,
 * and never at all on a password gate.
 *
 * So each of those pages asks this for the workspace behind the link and puts it in the header
 * (`ShareWorkspaceBrand`).
 *
 * The naming rule is the whole reason this is a function rather than a field read: a **team**
 * workspace is its own name, chosen to be seen. A **personal** workspace is called "Personal"
 * (`ensurePersonalOrgForUserId`), which is a label for its owner's own sidebar and means nothing to
 * a recipient — so a personal workspace is named after the person instead, and named nothing at all
 * rather than "Personal" if that cannot be resolved.
 */
import { Types } from "mongoose";

import { OrgModel } from "@/lib/models/Org";
import { UserModel } from "@/lib/models/User";

// The shape and the initials live in `./brand`, which imports nothing: this module talks to Mongo,
// and the header that renders a brand is in the client bundle. See that file for what broke.
import type { ShareWorkspaceBrand } from "./brand";

export type { ShareWorkspaceBrand } from "./brand";
export { brandInitials } from "./brand";

/**
 * The brand for one workspace, or null when there is nothing honest to show.
 *
 * Best-effort and never throws: a header that cannot name the sender renders without the mark,
 * which is what every one of these pages did before this existed. It must never be the reason a
 * shared document fails to open.
 */
export async function workspaceBrandForOrg(orgId: Types.ObjectId | string | null | undefined): Promise<ShareWorkspaceBrand | null> {
  try {
    const id = orgId ? String(orgId) : "";
    if (!id || !Types.ObjectId.isValid(id)) return null;
    const org = (await OrgModel.findOne({ _id: new Types.ObjectId(id), isDeleted: { $ne: true } })
      .select({ name: 1, avatarUrl: 1, type: 1, personalForUserId: 1 })
      .lean()) as
      | { name?: string | null; avatarUrl?: string | null; type?: string | null; personalForUserId?: Types.ObjectId | null }
      | null;
    if (!org) return null;

    const avatarUrl = typeof org.avatarUrl === "string" && org.avatarUrl.trim() ? org.avatarUrl.trim() : null;

    if (org.type === "personal") {
      // "Personal" is the owner's word for their own workspace, not a name a recipient can use.
      if (!org.personalForUserId) return null;
      const owner = (await UserModel.findById(org.personalForUserId).select({ name: 1, email: 1 }).lean()) as
        | { name?: string | null; email?: string | null }
        | null;
      const personName =
        (owner?.name ?? "").trim() ||
        // The local part of an address is a poor name but a true one; the domain is not ours to show.
        ((owner?.email ?? "").trim().split("@")[0] ?? "").trim();
      if (!personName) return null;
      return { name: personName, avatarUrl };
    }

    const name = (org.name ?? "").trim();
    if (!name) return null;
    return { name, avatarUrl };
  } catch {
    return null;
  }
}
