/**
 * Which earlier download request makes a new one redundant.
 *
 * A request is one person asking for one document through one link. The dedupe used to match on
 * the link and the address alone, which on a document link is the same thing; on a data room it is
 * not, and a recipient who asked for two of the room's documents inside a minute had the second
 * request silently dropped (code review 2026-09-23, Low). The document is part of the key now.
 */

/** Mongo filter for a still-pending request from the same person for the same document on the same link. */
export function pendingDuplicateFilter(input: {
  shareId: string;
  docId: unknown;
  requesterEmail: string;
  now: number;
  windowMs: number;
}): Record<string, unknown> {
  return {
    shareId: input.shareId,
    docId: input.docId,
    requesterEmail: input.requesterEmail,
    status: "pending",
    createdDate: { $gt: new Date(input.now - input.windowMs) },
  };
}
