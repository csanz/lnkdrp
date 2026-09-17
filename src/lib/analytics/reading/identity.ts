/**
 * Person ids used in URLs (`?person=`). They carry the link and the viewer key only — never an
 * email — and decoding rejects anything that is not exactly that shape.
 */
export type PersonIdParts = { shareId: string; kind: "a" | "u"; id: string };

const SHARE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const BOT_HASH_RE = /^[0-9a-f]{64}$/;
const USER_ID_RE = /^[0-9a-f]{24}$/;

/** `{shareId}.{kind}.{id}` where kind is `a` (anonymous botIdHash) or `u` (viewer user id). */
export function encodePersonId(parts: PersonIdParts): string {
  return `${parts.shareId}.${parts.kind}.${parts.id}`;
}

/** Parse a person id; null for anything that is not a well-formed link + viewer key. */
export function decodePersonId(s: unknown): PersonIdParts | null {
  if (typeof s !== "string") return null;
  const parts = s.split(".");
  if (parts.length !== 3) return null;
  const [shareId, kind, id] = parts;
  if (!SHARE_ID_RE.test(shareId)) return null;
  if (kind === "a" && BOT_HASH_RE.test(id)) return { shareId, kind, id };
  if (kind === "u" && USER_ID_RE.test(id)) return { shareId, kind, id };
  return null;
}
