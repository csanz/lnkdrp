/**
 * Keeping a recipient's volunteered identity up to date across the rows that already carry it.
 *
 * "Introduce yourself" is answered once per browser and then remembered in that browser's local
 * storage, so a recipient who comes back is recognised without being asked again. The catch: if
 * they *change* the answer — a typo fixed, a surname added, a work address instead of a personal
 * one — only the row for the link they happened to be on would learn about it. Every other row
 * this person had already written kept the old name, and the owner saw the same reader under two
 * names on two pages of the same product.
 *
 * So a changed introduction is written through to the rows that are already about this person.
 *
 * Two boundaries hold it in:
 *
 *   - **One owner.** Rows are updated inside the document owner's org, never globally. Telling
 *     this owner who you are is not telling every owner whose links you have ever opened.
 *   - **Anonymous rows only.** A signed-in viewer's name comes from their account (see the
 *     `UserModel` snapshot in the stats route); a typed-in name must never overwrite it.
 *
 * On a project link the stored key carries the document too (`projectViewerKey`), so one person
 * reading three files in a data room owns three rows whose keys all start with the same digest —
 * hence the prefix match rather than an equality test.
 */
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { ShareViewModel } from "@/lib/models/ShareView";
import { splitProjectViewerKey, viewerKeyMatchClause } from "@/lib/share/projectPublic";
import type { Types } from "mongoose";

export type PropagateViewerIdentityArgs = {
  /** The link the introduction was just given on — the fallback scope when the row has no org. */
  shareId: string;
  /** The analytics key this heartbeat wrote under; a project key is reduced to its viewer part. */
  botIdHash: string;
  /** The document owner's workspace. Present on every row written since links were materialised. */
  orgId?: Types.ObjectId | string | null;
  name?: string | null;
  email?: string | null;
};

/**
 * Has this person told this workspace something new about themselves?
 *
 * Asked *before* the row is written, and only when an introduction is present, because the viewer
 * replays the stored profile on every heartbeat: without this, "someone introduced themselves"
 * would land in the feed every few seconds for as long as they kept reading.
 *
 * Returns `{ isNew, changed }` — `changed` distinguishes a correction ("updated who they are")
 * from a first introduction, which are different events to a sender: one is a new contact, the
 * other is the same contact fixing a typo.
 */
export async function viewerIdentityNews({
  shareId,
  botIdHash,
  orgId,
  name,
  email,
}: PropagateViewerIdentityArgs): Promise<{ isNew: boolean; changed: boolean }> {
  const cleanName = typeof name === "string" && name.trim() ? name.trim() : null;
  const cleanEmail = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  if (!cleanName && !cleanEmail) return { isNew: false, changed: false };
  const viewerKey = splitProjectViewerKey(botIdHash).botIdHash;
  if (!viewerKey) return { isNew: false, changed: false };

  const scope = orgId ? { orgId } : { shareId };
  const person = { ...scope, $or: viewerKeyMatchClause(viewerKey) };
  const select = { viewerName: 1, viewerEmailSnapshot: 1 } as const;

  try {
    // Either collection can hold the answer: a reader has `ShareView` rows, a visitor who opened
    // nothing has only the arrival row.
    const [read, landed] = await Promise.all([
      // Sorted on `lastViewedAt`, which is indexed beside `orgId` on both collections.
      // `updatedDate` is not, so that sort ran in memory over the workspace's matched rows and,
      // past 32MB, threw — and the catch below turns a throw into "not news", so the event simply
      // stopped firing for exactly the workspaces with the most readers.
      ShareViewModel.findOne(person).select(select).sort({ lastViewedAt: -1 }).lean(),
      ProjectLinkViewModel.findOne({ ...scope, botIdHash: viewerKey }).select(select).sort({ lastViewedAt: -1 }).lean(),
    ]);
    const priors = [read, landed].filter(Boolean) as Array<{ viewerName?: string | null; viewerEmailSnapshot?: string | null }>;
    // Nobody has ever heard of them here.
    const known = priors.filter((p) => p.viewerName || p.viewerEmailSnapshot);
    if (!known.length) return { isNew: true, changed: false };
    // Already carrying exactly this: a replayed heartbeat, not an introduction.
    const matches = known.some(
      (p) => (!cleanName || p.viewerName === cleanName) && (!cleanEmail || p.viewerEmailSnapshot === cleanEmail),
    );
    if (matches) return { isNew: false, changed: false };
    return { isNew: false, changed: true };
  } catch {
    // Never announce on a failed read: a duplicate row in the feed is worse than a missing one.
    return { isNew: false, changed: false };
  }
}

/**
 * Write a changed introduction through to this viewer's other rows.
 *
 * Deliberately narrow in what it writes: only fields that were actually given, and only where the
 * stored value differs. A no-op update is not merely wasted work here — the realtime server
 * watches `shareviews` for exactly these two fields, and an update that changes nothing would put
 * a frame on the wire telling every open metrics page to refetch for no reason.
 *
 * Best-effort by contract: returns the number of rows changed and throws nothing the caller has to
 * handle beyond its own try/catch.
 */
export async function propagateViewerIdentity({
  shareId,
  botIdHash,
  orgId,
  name,
  email,
}: PropagateViewerIdentityArgs): Promise<number> {
  const cleanName = typeof name === "string" && name.trim() ? name.trim() : null;
  const cleanEmail = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  if (!cleanName && !cleanEmail) return 0;

  // A project row's key is `<digest><SEP><docId>`; the digest alone is the person.
  const viewerKey = splitProjectViewerKey(botIdHash).botIdHash;
  if (!viewerKey) return 0;

  const set: Record<string, unknown> = {};
  const changed: Array<Record<string, unknown>> = [];
  if (cleanName) {
    set.viewerName = cleanName;
    changed.push({ viewerName: { $ne: cleanName } });
  }
  if (cleanEmail) {
    set.viewerEmailSnapshot = cleanEmail;
    changed.push({ viewerEmailSnapshot: { $ne: cleanEmail } });
  }

  const scope = orgId ? { orgId } : { shareId };
  /** Never over an account-backed identity, and only where something differs. */
  const guards = [
    { $or: [{ viewerUserId: { $exists: false } }, { viewerUserId: null }] },
    { $or: changed },
  ];

  const res = await ShareViewModel.updateMany(
    {
      ...scope,
      $and: [
        // This person: the bare digest (a document link) or any key that starts with it (a project
        // link, one row per document read inside the room).
        { $or: viewerKeyMatchClause(viewerKey) },
        ...guards,
      ],
    },
    { $set: set },
  );

  /**
   * And the row that says they *arrived*.
   *
   * `ProjectLinkView` is keyed on (link, viewer) with the bare digest — no document suffix, because
   * it is about the person, not what they read. It is also the only row a visitor who opens a data
   * room and reads nothing ever writes, so leaving it nameless is precisely the case where a name
   * would have been worth most. Its own `updateMany` rather than a widened filter: different
   * collection, different key shape, same two guards.
   */
  let projectModified = 0;
  try {
    const projectRes = await ProjectLinkViewModel.updateMany(
      { ...scope, $and: [{ botIdHash: viewerKey }, ...guards] },
      { $set: set },
    );
    projectModified = typeof projectRes?.modifiedCount === "number" ? projectRes.modifiedCount : 0;
  } catch {
    // The reading rows are the ones the owner's metrics read; an arrival row that keeps an old name
    // is not worth failing the heartbeat that carried the new one.
  }

  return (typeof res?.modifiedCount === "number" ? res.modifiedCount : 0) + projectModified;
}
