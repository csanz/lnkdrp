/**
 * Client-safe activity presentation helpers.
 *
 * Pure functions (no Mongo/server imports) shared by the `/activity` page: filter groups and the
 * one-line sentence rendered for each event. Keep server-only logic in `src/lib/activity/log.ts`.
 */

/** Filter groups shown on the `/activity` page (empty `types` means "no type filter"). */
export const ACTIVITY_FILTERS = [
  { id: "all", label: "All", types: [] as string[] },
  {
    id: "uploads",
    label: "Uploads",
    types: ["upload.completed", "doc.processed", "doc.replaced", "doc.imported_url", "request.upload_received"],
  },
  {
    id: "sharing",
    label: "Sharing",
    types: [
      "share.updated",
      "share.password_set",
      "share.password_cleared",
      "download_request.created",
      "download_request.approved",
      "download_request.denied",
    ],
  },
  { id: "documents", label: "Documents", types: ["doc.created", "doc.deleted", "request_repo.created"] },
  { id: "views", label: "Views", types: ["share.viewed", "share.downloaded"] },
] as const;

export type ActivityFilterId = (typeof ACTIVITY_FILTERS)[number]["id"];

/** Shape of one `/api/activity` item as consumed by the UI. */
export type ActivityItem = {
  id: string;
  type: string;
  createdDate: string;
  actor: { userId: string | null; name: string | null; email: string | null; kind: string };
  agent: { client: string; label: string; version: string | null } | null;
  doc: { id: string; title: string | null; shareId: string | null } | null;
  project: { id: string; name: string | null } | null;
  meta: Record<string, unknown>;
};

/** Sentence fragments for one activity row (rendered as `subject verb object`). */
export type ActivitySentence = {
  /** Who did it: agent label, user name, or "Someone". */
  subject: string;
  /** What happened, e.g. `uploaded`. */
  verb: string;
  /** Primary target, e.g. the doc or project title. */
  object: string;
  /** Optional trailing detail, e.g. `via request link`. */
  suffix: string | null;
};

/** Display name for a user: name, else the local part of their email, else null. */
export function actorDisplayName(actor: ActivityItem["actor"]): string | null {
  const name = (actor?.name ?? "").trim();
  if (name) return name;
  const email = (actor?.email ?? "").trim();
  if (email) return email.split("@")[0] || email;
  return null;
}

/** Read a non-empty string from `meta[key]`, or null. */
function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Describe the `share.updated` `meta.changed` map in words ("enabled the share link, blocked PDF downloads"). */
function describeShareChanges(meta: Record<string, unknown>): string | null {
  const changed = meta?.changed;
  if (!changed || typeof changed !== "object") return null;
  const c = changed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof c.shareEnabled === "boolean") parts.push(c.shareEnabled ? "enabled the share link" : "disabled the share link");
  if (typeof c.shareAllowPdfDownload === "boolean")
    parts.push(c.shareAllowPdfDownload ? "allowed PDF downloads" : "blocked PDF downloads");
  if (typeof c.shareAllowRevisionHistory === "boolean")
    parts.push(c.shareAllowRevisionHistory ? "made version history visible" : "hid version history");
  return parts.length ? parts.join(", ") : null;
}

/**
 * Build the one-line sentence for an activity item.
 *
 * Subject precedence: agent label (e.g. "Claude Code") > user name > "Someone".
 */
export function describeActivity(item: ActivityItem): ActivitySentence {
  const docTitle = item.doc?.title?.trim() || "Untitled document";
  const projectName = item.project?.name?.trim() || metaString(item.meta, "projectName") || "a request inbox";
  const user = actorDisplayName(item.actor);
  const subject = item.agent?.label || user || "Someone";
  const email = metaString(item.meta, "email");

  switch (item.type) {
    case "doc.created":
      return { subject, verb: "created", object: docTitle, suffix: null };
    case "doc.imported_url":
      return { subject, verb: "imported", object: docTitle, suffix: "from a URL" };
    case "upload.completed":
      return { subject, verb: "uploaded", object: docTitle, suffix: null };
    case "doc.processed":
      return { subject: "Processing", verb: "finished for", object: docTitle, suffix: null };
    case "doc.replaced": {
      const v = item.meta?.version;
      const version = typeof v === "number" && Number.isFinite(v) ? ` (v${v})` : "";
      return {
        subject: user || item.agent?.label || "Someone",
        verb: "replaced",
        object: docTitle,
        suffix: user ? version || null : `via update link${version}`,
      };
    }
    case "doc.deleted":
      return { subject, verb: "deleted", object: docTitle, suffix: null };
    case "share.updated": {
      const detail = describeShareChanges(item.meta);
      return detail
        ? { subject, verb: detail, object: "", suffix: `for ${docTitle}` }
        : { subject, verb: "updated share settings for", object: docTitle, suffix: null };
    }
    case "share.password_set":
      return { subject, verb: "set a password on", object: docTitle, suffix: null };
    case "share.password_cleared":
      return { subject, verb: "removed the password from", object: docTitle, suffix: null };
    case "request_repo.created":
      return { subject, verb: "created request inbox", object: item.project?.name?.trim() || docTitle, suffix: null };
    case "request.upload_received":
      return { subject: user || "Someone", verb: "submitted a document to", object: projectName, suffix: "via request link" };
    case "share.viewed": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      return { subject: who, verb: "viewed", object: docTitle, suffix: null };
    }
    case "share.downloaded":
      return { subject: user || "Someone", verb: "downloaded", object: docTitle, suffix: null };
    case "download_request.created":
      return { subject: email || "Someone", verb: "requested to download", object: docTitle, suffix: null };
    case "download_request.approved":
      return { subject, verb: "approved a download request for", object: docTitle, suffix: email ? `(${email})` : null };
    case "download_request.denied":
      return { subject, verb: "denied a download request for", object: docTitle, suffix: email ? `(${email})` : null };
    default:
      return { subject, verb: item.type.replace(/[._]/g, " "), object: docTitle, suffix: null };
  }
}
