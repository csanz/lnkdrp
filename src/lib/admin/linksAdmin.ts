/**
 * Share-link shaping for the admin Links browser (`/a/data/links`).
 *
 * A document used to own exactly one link, so the admin area never needed a link surface. It owns
 * many now — each with its own label, audience, password, expiry, download setting and analytics —
 * and support questions ("is that link still live?", "did we password it?") had no answer outside
 * Mongo. The state a reader cares about is a combination of four stored fields rather than one
 * status column, so the derivation lives here, once, next to the filter fragments that have to
 * agree with it: the server decides which rows to load and the page decides what pill to draw, and
 * the two must not drift.
 *
 * Deliberately dependency-free (no mongoose, no models) — the fragments are plain objects the route
 * merges into its own `$and`, which keeps this module testable without a database.
 */

/** What a link is, once the four stored flags are read together. Precedence order, worst first. */
export type AdminLinkState = "archived" | "disabled" | "expired" | "active";

/** The state-ish filters the Links browser offers. `""` means "no constraint". */
export type AdminLinkStateFilter = "" | AdminLinkState | "password";

/** Values accepted by the `state` query param, for validation and for the page's `<Select>`. */
export const ADMIN_LINK_STATE_FILTERS = ["active", "disabled", "expired", "archived", "password"] as const;

/** Narrow a raw query-string value to a filter this module understands. */
export function isAdminLinkStateFilter(v: string): v is AdminLinkStateFilter {
  return v === "" || (ADMIN_LINK_STATE_FILTERS as readonly string[]).includes(v);
}

/** The stored fields that decide a link's state. Dates as ISO strings or `Date`, both appear. */
export type AdminLinkStateInput = {
  enabled?: boolean | null;
  archivedAt?: string | Date | null;
  expiresAt?: string | Date | null;
};

/** Parse a stored date-ish value; returns null for absent or unparseable input rather than NaN. */
function asDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.valueOf()) ? null : d;
}

/**
 * Collapse the four flags into the one word a reader wants.
 *
 * Precedence is archived → disabled → expired → active, so a row reads as the strongest reason it
 * will not resolve: an archived link whose expiry has also passed is "archived", because un-setting
 * the expiry would not bring it back. `enabled` defaults to true to match the schema default, so a
 * projection that omitted the field does not invent a disabled link.
 */
export function deriveLinkState(input: AdminLinkStateInput, now: Date): AdminLinkState {
  if (asDate(input.archivedAt)) return "archived";
  if (input.enabled === false) return "disabled";
  const expiresAt = asDate(input.expiresAt);
  if (expiresAt && expiresAt.valueOf() <= now.valueOf()) return "expired";
  return "active";
}

/**
 * The pill text for a state.
 *
 * `disabledByDocSwitch` is called out because the two disabled links behave differently: one the
 * sender revoked on its own, the other the document's master switch turned off and turning the
 * document back on will re-enable. Support has to tell them apart.
 */
export function linkStateLabel(state: AdminLinkState, opts?: { disabledByDocSwitch?: boolean | null }): string {
  if (state === "disabled" && opts?.disabledByDocSwitch) return "Disabled (doc switch)";
  if (state === "archived") return "Archived";
  if (state === "disabled") return "Disabled";
  if (state === "expired") return "Expired";
  return "Active";
}

/**
 * The Mongo fragment for one filter value, or null when the filter is "everything".
 *
 * Each fragment says exactly what its name says and nothing more — "disabled" is the `enabled` flag
 * being off, whether or not the row is also archived — so a reader of the table can trust the
 * filter label. The route merges these under `$and` because "active" carries its own `$or` and the
 * free-text search carries another.
 *
 * The `$ne: null` on `expiresAt` is redundant under Mongo's type bracketing (`$lte` against a Date
 * never matches a null) and is kept because the intent is easier to read than the bracketing rule.
 */
export function linkStateFilterFragment(state: AdminLinkStateFilter, now: Date): Record<string, unknown> | null {
  switch (state) {
    case "active":
      return {
        enabled: true,
        archivedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };
    case "disabled":
      return { enabled: false };
    case "expired":
      return { expiresAt: { $ne: null, $lte: now } };
    case "archived":
      return { archivedAt: { $ne: null } };
    case "password":
      // Presence of the hash is the only password question an admin may ask; the value and the
      // reveal-copy ciphertext are never read here.
      return { passwordHash: { $ne: null } };
    default:
      return null;
  }
}

// `publicLinkPath` used to live here, building `/s/:shareId` and `/p/:shareId` for the links
// board. It is deliberately gone: admin must never offer a one-click path into a customer's
// document, and an exported helper that builds one is an invitation to add the column back. The
// admin surface shows the slug; anyone who genuinely needs the page can paste it. Guarded by
// tests/lib/adminDocPrivacy.test.ts.

/** The three places a document's name can live, in the order the app itself prefers them. */
export type DocTitleSource = { title?: string | null; docName?: string | null; fileName?: string | null };

/**
 * Pick the name to show for a document.
 *
 * `title` is the owner's own name for it, `docName` is inferred from the content and `fileName` is
 * the last upload's filename; older rows have only the last of those.
 */
export function pickDocTitle(src: DocTitleSource | null | undefined): string | null {
  if (!src) return null;
  for (const v of [src.title, src.docName, src.fileName]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
