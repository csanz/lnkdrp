/**
 * How one reader is named in a URL: `u_<userId>` signed in, `a_<botIdHash>` for a device.
 *
 * A leaf on purpose. The reader page defines the route and used to own this, which was fine while
 * only other client components linked to it — then the view-notification email wanted to link to a
 * reader too, and a server module cannot import a `"use client"` component to find out how the
 * address is spelled. Both sides read it here instead, so an email can never link to a page shape
 * that no longer exists.
 *
 * Readable rather than opaque, deliberately: an owner can see from the address whether the reader
 * it is about is an account or a browser.
 */

export type ViewerRouteKind = "authed" | "anon";

/** The path segment for one reader. */
export function viewerRouteKey(kind: ViewerRouteKind, key: string): string {
  return `${kind === "authed" ? "u" : "a"}_${key}`;
}

/** The inverse, for the page reading its own route. `null` when the segment is not one of ours. */
export function parseViewerRouteKey(raw: string): { kind: ViewerRouteKind; key: string } | null {
  const value = decodeURIComponent(raw ?? "").trim();
  if (value.startsWith("u_")) return { kind: "authed", key: value.slice(2) };
  if (value.startsWith("a_")) return { kind: "anon", key: value.slice(2) };
  return null;
}

/**
 * The full address of a reader's page, in the scope their reading belongs to.
 *
 * Scope is not a detail. A read through a project link belongs to the **project**
 * (`src/lib/analytics/docScope.ts`), so that reader may not appear in the document's own viewer
 * list at all — a document-scoped address for one of them is a link to an empty page that says
 * "no reader by that id". The caller passes the project when the link has one, and gets the right
 * page either way.
 */
export function viewerPageHref(args: {
  appUrl?: string;
  /** Present when the reading came through a project link; it wins over `docId`. */
  projectId?: string | null;
  docId?: string | null;
  kind: ViewerRouteKind;
  /** The user id, or the reader's bare device digest — never a project viewer key with its
   *  document suffix, which addresses a reader-and-a-file rather than a person. */
  key: string;
}): string | null {
  const { appUrl = "", projectId, docId, kind, key } = args;
  if (!key) return null;
  const base = projectId
    ? `/project/${encodeURIComponent(projectId)}`
    : docId
      ? `/doc/${encodeURIComponent(docId)}`
      : null;
  if (!base) return null;
  return `${appUrl}${base}/metrics/viewer/${encodeURIComponent(viewerRouteKey(kind, key))}`;
}
