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
      "share_link.created",
      "share_link.updated",
      "share_link.revoked",
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

/**
 * Suffix for a processing run: "N credits" / "1 credit" when it charged credits, and "summary by
 * <agent>" when the uploading agent wrote the summary itself (0 credits). Null when neither applies.
 */
function creditsSuffix(meta: Record<string, unknown> | null | undefined): string | null {
  const parts: string[] = [];
  const v = meta?.credits;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) parts.push(`${v} credit${v === 1 ? "" : "s"}`);
  const by = meta?.summaryBy;
  if (typeof by === "string" && by.trim()) parts.push(`summary by ${by.trim()}`);
  return parts.length ? parts.join(" · ") : null;
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
 * "via {label}" for a view/download that came through a named share link.
 *
 * A document's default link is unnamed as far as the reader is concerned ("Default link" is an
 * internal label), so it never adds a suffix; only the links a sender created and named do.
 */
function linkSuffix(meta: Record<string, unknown>): string | null {
  if (meta?.isDefaultLink === true) return null;
  const label = metaString(meta, "linkLabel");
  if (!label || label === DEFAULT_LINK_LABEL) return null;
  return `via ${label}`;
}

/** Label the default link of a document carries; never shown as a "via …" suffix. */
const DEFAULT_LINK_LABEL = "Default link";

/**
 * Build the one-line sentence for an activity item.
 *
 * Subject: when an agent acted for a known user the two are co-credited, GitHub style
 * ("Christian Sanz and Claude Code"); otherwise agent label > user name > "Someone".
 */
export function describeActivity(item: ActivityItem): ActivitySentence {
  const docTitle = item.doc?.title?.trim() || "Untitled document";
  const projectName = item.project?.name?.trim() || metaString(item.meta, "projectName") || "a request inbox";
  const user = actorDisplayName(item.actor);
  const subject = item.agent?.label && user ? `${user} and ${item.agent.label}` : item.agent?.label || user || "Someone";
  const email = metaString(item.meta, "email");

  switch (item.type) {
    case "doc.created":
      return { subject, verb: "created", object: docTitle, suffix: null };
    case "doc.imported_url":
      return { subject, verb: "imported", object: docTitle, suffix: "from a URL" };
    case "upload.completed":
      return { subject, verb: "uploaded", object: docTitle, suffix: null };
    case "doc.processed": {
      const cost = creditsSuffix(item.meta);
      return { subject: "Processing", verb: "finished for", object: docTitle, suffix: cost };
    }
    case "doc.replaced": {
      const v = item.meta?.version;
      const version = typeof v === "number" && Number.isFinite(v) ? ` (v${v})` : "";
      const base = user ? version || null : `via update link${version}`;
      const cost = creditsSuffix(item.meta);
      return {
        subject: user || item.agent?.label || "Someone",
        verb: "replaced",
        object: docTitle,
        suffix: base && cost ? `${base} · ${cost}` : base ?? cost,
      };
    }
    case "doc.deleted":
      return { subject, verb: "deleted", object: docTitle, suffix: null };
    case "share.updated": {
      // Project share toggle (no doc on the row): meta.scope === "project" with shareEnabled.
      if (!item.doc && item.project?.name) {
        const raw = (item.meta as Record<string, unknown> | null | undefined)?.shareEnabled;
        const verb =
          typeof raw === "boolean"
            ? raw
              ? "turned sharing on for project"
              : "turned sharing off for project"
            : "updated sharing for project";
        return { subject, verb, object: item.project.name.trim(), suffix: null };
      }
      const detail = describeShareChanges(item.meta);
      return detail
        ? { subject, verb: detail, object: "", suffix: `for ${docTitle}` }
        : { subject, verb: "updated share settings for", object: docTitle, suffix: null };
    }
    case "share_link.created": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: "created a link", object: `“${label}”`, suffix: `for ${docTitle}` };
    }
    case "share_link.updated": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: "updated link", object: `“${label}”`, suffix: `on ${docTitle}` };
    }
    case "share_link.revoked": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: "removed link", object: `“${label}”`, suffix: `from ${docTitle}` };
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
      return { subject: who, verb: "viewed", object: docTitle, suffix: linkSuffix(item.meta) };
    }
    case "share.downloaded":
      return { subject: user || "Someone", verb: "downloaded", object: docTitle, suffix: linkSuffix(item.meta) };
    case "download_request.created":
      return { subject: email || "Someone", verb: "requested to download", object: docTitle, suffix: null };
    case "download_request.approved":
      return { subject, verb: "approved a download request for", object: docTitle, suffix: email ? `(${email})` : null };
    case "download_request.denied":
      return { subject, verb: "denied a download request for", object: docTitle, suffix: email ? `(${email})` : null };
    case "agent.key_created": {
      const name = metaString(item.meta, "name") || metaString(item.meta, "prefix") || "a key";
      return { subject: user || "Someone", verb: "created an agent key", object: `“${name}”`, suffix: null };
    }
    case "agent.key_revoked": {
      const name = metaString(item.meta, "name") || metaString(item.meta, "prefix") || "a key";
      return { subject: user || "Someone", verb: "revoked an agent key", object: `“${name}”`, suffix: null };
    }
    case "agent.key_verified": {
      const client = metaString(item.meta, "client") || "curl";
      const keyName = metaString(item.meta, "name");
      return { subject: user || "Someone", verb: "verified an agent key", object: keyName ? `“${keyName}”` : "", suffix: `with ${client}` };
    }
    case "agent.connected": {
      const client = item.agent?.label || metaString(item.meta, "client") || "An agent";
      const keyName = metaString(item.meta, "name");
      return { subject: client, verb: "connected to", object: "this workspace", suffix: keyName ? `using “${keyName}”` : null };
    }
    case "plan.limit_reached": {
      // meta.limit is the LimitKey ("active_links", "projects", …); name the wall that was hit.
      const limit = metaString(item.meta, "limit") ?? "";
      const wall =
        limit === "active_links" ? "the link limit" : limit === "projects" ? "the project limit" : limit === "collaborators" ? "the collaborator limit" : "a plan limit";
      const target = item.doc?.title?.trim() ? `sharing ${docTitle}` : item.project?.name?.trim() ? `on ${item.project.name.trim()}` : "";
      return { subject, verb: `hit ${wall}`, object: target, suffix: null };
    }
    case "plan.grace_started":
      return { subject: "This workspace", verb: "entered its grace period", object: "", suffix: "over the Free limits at launch" };
    case "plan.grace_reminder":
      return { subject: "Grace period", verb: "ends soon for", object: "this workspace", suffix: null };
    case "plan.grace_blocked":
      return { subject: "Grace period", verb: "ended for", object: "this workspace", suffix: "Free limits now apply" };
    case "plan.upgraded":
      return { subject, verb: "upgraded", object: "this workspace", suffix: "to Pro" };
    case "summary.generated": {
      // A skipped summary written later (doc page action or the monthly re-queue).
      const cost = creditsSuffix(item.meta);
      const failed = metaString(item.meta, "summary") !== "done";
      return { subject, verb: failed ? "could not write the AI summary for" : "wrote the AI summary for", object: docTitle, suffix: cost };
    }
    case "credits.exhausted": {
      // The upload completed but the AI summary was skipped for want of credits.
      const code = metaString(item.meta, "code");
      const why = code === "daily_cap" ? "daily credit cap reached" : "out of AI credits";
      return { subject: "AI summary skipped", verb: "for", object: docTitle, suffix: why };
    }
    default:
      return { subject, verb: item.type.replace(/[._]/g, " "), object: docTitle, suffix: null };
  }
}
