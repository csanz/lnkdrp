/**
 * Who a reader is, from what the link's share views know.
 *
 * A data-room reader introduces themselves once, on the landing page, and that is stored on the
 * link's arrival row (`ProjectLinkView`, keyed by the bare device digest), or on a `ShareView`
 * row when they introduce themselves inside a document. The viewer's timing posts for the
 * documents they then open carry no name, so anything built from those posts alone (a visit
 * brief row, a Slack "opened" event) called an introduced reader "Someone" while the activity
 * feed, which reads both collections, named them. These helpers read the same two collections
 * the feed does, so every surface agrees on who the reader is.
 */
import { Types } from "mongoose";

import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { ShareViewModel } from "@/lib/models/ShareView";
import { splitProjectViewerKey, viewerKeyMatchClause } from "@/lib/share/projectPublic";

export type ShareViewIdentity = {
  viewerUserId?: unknown;
  viewerName?: string | null;
  viewerEmail?: string | null;
  viewerEmailSnapshot?: string | null;
  lastViewedAt?: Date | null;
};

export type ReaderIdentity = { viewerUserId?: Types.ObjectId; viewerName?: string; viewerEmail?: string };

/** The link's share views for this reader, newest first. `botIdHash` may be the project composite. */
export async function loadShareViewIdentities(shareId: string, botIdHash: string): Promise<ShareViewIdentity[]> {
  if (!shareId || !botIdHash) return [];
  const person = splitProjectViewerKey(botIdHash).botIdHash || botIdHash;
  const select = { viewerUserId: 1, viewerName: 1, viewerEmail: 1, viewerEmailSnapshot: 1, lastViewedAt: 1 };
  const [views, arrivals] = await Promise.all([
    ShareViewModel.find({ shareId, $or: viewerKeyMatchClause(person) }).select(select).sort({ lastViewedAt: -1 }).limit(25).lean() as unknown as Promise<ShareViewIdentity[]>,
    // The arrival row: a data-room reader who introduced themselves on the landing page and read
    // nothing yet has no ShareView at all, and this is the only place their name exists.
    ProjectLinkViewModel.find({ shareId, botIdHash: person }).select(select).limit(5).lean() as unknown as Promise<ShareViewIdentity[]>,
  ]);
  const t = (v: ShareViewIdentity) => (v.lastViewedAt ? new Date(v.lastViewedAt).getTime() : 0);
  return [...views, ...arrivals].sort((a, b) => t(b) - t(a));
}

/**
 * What `row` is missing that the share views know. Pure, so it is testable: the row's own values
 * win (they were typed on this very sitting), then the newest share view that has each field. A
 * signed-in reader's account id comes along too, so the account name can be looked up.
 */
export function pickReaderIdentity(
  row: { viewerUserId?: unknown; viewerName?: string | null; viewerEmail?: string | null },
  views: readonly ShareViewIdentity[],
): ReaderIdentity {
  const out: ReaderIdentity = {};
  const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (!row.viewerUserId) {
    const u = views.find((v) => v.viewerUserId && Types.ObjectId.isValid(String(v.viewerUserId)));
    if (u) out.viewerUserId = new Types.ObjectId(String(u.viewerUserId));
  }
  if (!clean(row.viewerName)) {
    const n = views.map((v) => clean(v.viewerName)).find(Boolean);
    if (n) out.viewerName = n.slice(0, 300);
  }
  if (!clean(row.viewerEmail)) {
    const e = views.map((v) => clean(v.viewerEmail) ?? clean(v.viewerEmailSnapshot)).find(Boolean);
    if (e) out.viewerEmail = e.toLowerCase().slice(0, 320);
  }
  return out;
}

/** Both steps at once, for callers that hold only the event: `{}` when nothing is known. */
export async function resolveReaderIdentity(shareId: string | null | undefined, botIdHash: string | null | undefined, row: { viewerUserId?: unknown; viewerName?: string | null; viewerEmail?: string | null }): Promise<ReaderIdentity> {
  if (!shareId || !botIdHash) return {};
  try {
    return pickReaderIdentity(row, await loadShareViewIdentities(shareId, botIdHash));
  } catch {
    return {};
  }
}
