/**
 * Projections that opt a query back in to the share-password material.
 *
 * `ShareLink.passwordSalt/Hash/Enc/EncIv/EncTag` and the `Doc.sharePassword*` mirror are
 * `select: false` (src/lib/models/ShareLink.ts, src/lib/models/Doc.ts): a query that does not ask
 * for them does not receive them, so an analytics join, a Slack card, a notification fan-out or an
 * admin listing cannot carry a hash out of the database by accident. The price is that every reader
 * which gates on the material must say so, and a reader that forgets fails **open**:
 * `shareLinkUnlocked` treats a row with no hash as a link with no password. So the readers import
 * one of these constants rather than spelling the list again, and
 * tests/lib/sharePasswordSelect.test.ts pins both the schema flag and the resolvers' projections.
 *
 * Lives here rather than on the models because the service tests mock `@/lib/models/ShareLink`
 * and `@/lib/models/Doc` with factories, and a factory-mocked module exports nothing the factory
 * did not name.
 *
 * Two shapes because Mongoose takes them in two places: the string goes as the second argument of
 * `find`/`findOne` (and as `projection` on `findOneAndUpdate`); the object form spreads into a
 * projection that already carries a `$meta` text score, where a string cannot go. `+field` keys add
 * to whatever the query selects and never make the projection inclusive, so the row keeps every
 * other field it would have had.
 */

/** The five `ShareLink` password fields, in the order the schema declares them. */
export const SHARE_LINK_PASSWORD_FIELDS = ["passwordSalt", "passwordHash", "passwordEnc", "passwordEncIv", "passwordEncTag"] as const;

/** The five `Doc` mirror fields (the default link's material, kept for one release of readers). */
export const DOC_PASSWORD_FIELDS = [
  "sharePasswordSalt",
  "sharePasswordHash",
  "sharePasswordEnc",
  "sharePasswordEncIv",
  "sharePasswordEncTag",
] as const;

/** `"+passwordSalt +passwordHash ..."`: pass as the projection of a `ShareLink` `find`/`findOne`. */
export const WITH_LINK_PASSWORD: string = SHARE_LINK_PASSWORD_FIELDS.map((f) => `+${f}`).join(" ");

/** The same opt-in as an object, for spreading into a `$meta`-carrying projection. */
export const WITH_LINK_PASSWORD_PROJECTION: Record<string, 1> = Object.fromEntries(
  SHARE_LINK_PASSWORD_FIELDS.map((f) => [`+${f}`, 1]),
) as Record<string, 1>;

/** `"+sharePasswordSalt ..."`: the whole `Doc` mirror, for the one writer that copies it onto a link. */
export const WITH_DOC_PASSWORD: string = DOC_PASSWORD_FIELDS.map((f) => `+${f}`).join(" ");

/**
 * Just the hash, for the owner-side reads that only ask "is a password set?". The salt and the
 * decryptable copy stay unselected on those paths, so a handler that answers a boolean cannot leak
 * more than one however it changes.
 */
export const WITH_DOC_PASSWORD_HASH = "+sharePasswordHash";
