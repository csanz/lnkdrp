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
      "share_link.password_revealed",
      "share.password_set",
      "share.password_cleared",
      "download_request.created",
      "download_request.approved",
      "download_request.denied",
    ],
  },
  { id: "documents", label: "Documents", types: ["doc.created", "doc.deleted", "doc.archived", "doc.unarchived", "doc.contained", "doc.uncontained", "request_repo.created"] },
  {
    id: "projects",
    label: "Projects",
    types: ["project.created", "project.updated", "project.deleted", "doc.added_to_project", "doc.removed_from_project"],
  },
  // Filing, kept out of Documents and Projects on purpose: a burst of tagging would otherwise
  // drown the rows about the documents themselves, and "show me what got filed" is its own
  // question.
  { id: "tags", label: "Tags", types: ["tag.applied", "tag.removed"] },
  // Where the workspace's activity goes besides email: a Slack channel wired up or removed.
  { id: "integrations", label: "Integrations", types: ["integration.slack_connected", "integration.slack_disconnected"] },
  // What *recipients* did, which is also what keeps them out of the workspace donut: its
  // denominator is work done here, and `ACTIVITY_WORK_TYPES` excludes this group wholesale
  // (see `NOT_WORK` in ./summary.ts). Entering a password belongs with the rest of a recipient's
  // visit, not beside the sender's link settings — filed under Sharing it was counted as work
  // somebody in this workspace had done.
  {
    id: "views",
    label: "Views",
    types: ["share.viewed", "share.downloaded", "project.landed", "viewer.introduced", "share.unlocked", "share.visit_briefed"],
  },
  {
    id: "members",
    label: "Members",
    types: ["member.invited", "member.joined", "member.removed", "member.left"],
  },
] as const;

export type ActivityFilterId = (typeof ACTIVITY_FILTERS)[number]["id"];

/** Shape of one `/api/activity` item as consumed by the UI. */
export type ActivityItem = {
  id: string;
  type: string;
  createdDate: string;
  actor: { userId: string | null; name: string | null; email: string | null; kind: string };
  agent: { client: string; label: string; version: string | null } | null;
  doc: { id: string; title: string | null; shareId: string | null; deleted?: boolean } | null;
  project: { id: string; name: string | null } | null;
  meta: Record<string, unknown>;
  /**
   * The page about the person this row names, when there is one — the same reader page the metrics
   * lists lead to. Built by `/api/activity` (from `meta.viewerKey`, which is deleted before the row
   * is sent) and absent on a workspace that cannot see viewer identities.
   */
  readerHref?: string | null;
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
 * Suffix for a processing run: "summary by <agent>" when the uploading agent wrote the summary
 * itself rather than the model. Null otherwise.
 *
 * It used to lead with the price - "6 credits" on every replacement and every processed upload.
 * That was the wrong surface for it. The feed answers "what happened to my documents", and those
 * two events fire automatically on work somebody did for an entirely different reason, so the cost
 * appeared on the rows that repeat most and attached a number the reader cannot act on from here.
 * A feed that prices every line reads like a meter rather than a record. Credits have their own
 * surfaces - the dashboard card, the sidebar, /credits - and `credits.exhausted` still speaks up
 * in the feed, because running out is an event rather than a price tag.
 *
 * `meta.credits` is still written and still read by the admin and usage views; only the sentence
 * changed.
 */
function agentSummarySuffix(meta: Record<string, unknown> | null | undefined): string | null {
  const by = meta?.summaryBy;
  return typeof by === "string" && by.trim() ? `summary by ${by.trim()}` : null;
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
 * Where a view or download came in through: the data room, or the named link.
 *
 * A reading inside a project link is the case worth naming first. The reader did not open this
 * document's own link at all — they opened the room and picked a file out of it — and until this
 * said so, a sender looking at "Michael J viewed USAVX Deck" had no way to tell that from a reading
 * of the link they had sent one investor, which is a different fact about a different audience. The
 * room's own links are named for the room ("Default link"), so its label adds nothing beside it.
 *
 * Otherwise: a document's default link is unnamed as far as the reader is concerned ("Default link"
 * is an internal label), so it never adds a suffix; only the links a sender created and named do.
 *
 * `alreadyNamesProject` is for the sentences whose object IS the room (`project.landed`), which
 * would otherwise read "opened Data room in Data room".
 */
function linkSuffix(meta: Record<string, unknown>, opts?: { alreadyNamesProject?: boolean }): string | null {
  const projectName = opts?.alreadyNamesProject ? null : metaString(meta, "projectName");
  if (projectName) return `in ${projectName}`;
  if (meta?.isDefaultLink === true) return null;
  const label = metaString(meta, "linkLabel");
  if (!label || label === DEFAULT_LINK_LABEL) return null;
  return `via ${label}`;
}

/**
 * Verb for a link update from `meta.values` (new values; the password only as set/cleared). One
 * change reads specifically ("turned off downloads on"); several fall back to "updated".
 */
function linkUpdateVerb(meta: Record<string, unknown>): string {
  const values = meta?.values && typeof meta.values === "object" ? (meta.values as Record<string, unknown>) : null;
  if (!values) return "updated link";
  const keys = Object.keys(values);
  if (keys.length !== 1) return keys.length === 0 ? "updated link" : "changed settings of link";
  const [k] = keys;
  const v = values[k!];
  switch (k) {
    case "enabled":
      return v ? "turned on link" : "turned off link";
    case "allowDownload":
      return v ? "allowed downloads on link" : "turned off downloads on link";
    case "allowRevisionHistory":
      return v ? "let recipients browse versions on link" : "hid versions on link";
    case "label":
      return "renamed a link to";
    case "expires":
      return v === "set" ? "set an expiry on link" : "removed the expiry from link";
    case "password":
      return v === "set" ? "set a password on link" : "removed the password from link";
    case "isDefault":
      return "made default the link";
    default:
      return "updated link";
  }
}

/** Label the default link of a document carries; never shown as a "via …" suffix. */
const DEFAULT_LINK_LABEL = "Default link";

/**
 * Build the one-line sentence for an activity item.
 *
 * Subject: when an agent acted for a known user the two are co-credited, GitHub style
 * ("Christian Sanz and Claude Code"); otherwise agent label > user name > "Someone".
 */

/** The tag a filing event was about, by the name copied into the event when it happened. */
function tagNameLabel(item: ActivityItem): string {
  return metaString(item.meta, "tagName") || "a tag";
}

/**
 * What was filed: the document, or the project when the row is about one.
 *
 * A tag lands on either, and the two rows read differently — "tagged the Series A deck" against
 * "tagged the data room" — so the sentence asks the event which it was rather than assuming a
 * document and printing "Untitled document" for every project.
 */
function tagTargetLabel(item: ActivityItem, docTitle: string): string {
  return metaString(item.meta, "targetKind") === "project" ? projectLabel(item) : docTitle;
}

/** A project's name for a sentence: the live name, else the name recorded when the event was logged (deleted projects). */
function projectLabel(item: ActivityItem): string {
  return item.project?.name?.trim() || metaString(item.meta, "projectName") || "a project";
}

/**
 * What a share link hangs off: the document, or the project when the row has no document
 * (a project link — docs/prds/lnkdrp-project-links.md). Keeps the `share_link.*` and password
 * sentences from announcing every project link as belonging to "Untitled document".
 *
 * Every sentence that names what a link belongs to goes through here. Three of them did and three
 * did not, which is how revealing a data room's password came out as "viewed the password for
 * “Accel · locked” on Untitled document" — a document that does not exist, named in a sentence
 * about a project.
 */
function linkOwnerLabel(item: ActivityItem, docTitle: string): string {
  if (!item.doc && (item.project?.name || metaString(item.meta, "projectName"))) return `project ${projectLabel(item)}`;
  return docTitle;
}

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
      // `via: "bytes"` is `import-bytes` (an MCP tool call carrying the file inline, no public
      // URL involved) rather than `import-url`'s actual URL fetch — same event, different suffix.
      return { subject, verb: "imported", object: docTitle, suffix: metaString(item.meta, "via") === "bytes" ? "from a file" : "from a URL" };
    case "upload.completed":
      return { subject, verb: "uploaded", object: docTitle, suffix: null };
    case "doc.processed": {
      const by = agentSummarySuffix(item.meta);
      return { subject: "Processing", verb: "finished for", object: docTitle, suffix: by ? `· ${by}` : null };
    }
    case "doc.replaced": {
      const v = item.meta?.version;
      const version = typeof v === "number" && Number.isFinite(v) ? ` (v${v})` : "";
      const base = user ? version || null : `via update link${version}`;
      const by = agentSummarySuffix(item.meta);
      return {
        subject: user || item.agent?.label || "Someone",
        verb: "replaced",
        object: docTitle,
        suffix: base && by ? `${base} · ${by}` : base ?? by,
      };
    }
    case "doc.deleted":
      return { subject, verb: "deleted", object: docTitle, suffix: null };
    case "doc.archived":
      return { subject, verb: "archived", object: docTitle, suffix: "(its links stop working)" };
    case "doc.unarchived":
      return { subject, verb: "unarchived", object: docTitle, suffix: null };
    case "doc.contained":
      return { subject, verb: "kept", object: docTitle, suffix: "inside its data room only" };
    case "doc.uncontained":
      return { subject, verb: "listed", object: docTitle, suffix: "in the workspace again" };
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
      // A project link carries a project and no doc (docs/prds/lnkdrp-project-links.md); without
      // this branch every one of them reads "for Untitled document", the same way the project share
      // toggle above would.
      return { subject, verb: "created a link", object: `“${label}”`, suffix: `for ${linkOwnerLabel(item, docTitle)}` };
    }
    case "share_link.updated": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: linkUpdateVerb(item.meta), object: `“${label}”`, suffix: `on ${linkOwnerLabel(item, docTitle)}` };
    }
    case "share_link.revoked": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: "removed link", object: `“${label}”`, suffix: `from ${linkOwnerLabel(item, docTitle)}` };
    }
    case "share_link.password_revealed": {
      const label = metaString(item.meta, "linkLabel") || "a link";
      return { subject, verb: "viewed the password for", object: `“${label}”`, suffix: `on ${linkOwnerLabel(item, docTitle)}` };
    }
    case "share.password_set":
      return { subject, verb: "set a password on", object: linkOwnerLabel(item, docTitle), suffix: null };
    case "share.password_cleared":
      return { subject, verb: "removed the password from", object: linkOwnerLabel(item, docTitle), suffix: null };
    case "project.created":
      return { subject, verb: "created project", object: projectLabel(item), suffix: null };
    case "project.updated":
      return { subject, verb: "updated project", object: projectLabel(item), suffix: null };
    case "project.deleted":
      return { subject, verb: "deleted project", object: projectLabel(item), suffix: "(its documents were kept)" };
    case "doc.added_to_project":
      return { subject, verb: "added", object: docTitle, suffix: `to ${projectLabel(item)}` };
    case "doc.removed_from_project":
      return { subject, verb: "removed", object: docTitle, suffix: `from ${projectLabel(item)}` };
    // Filing. The tag's name is copied into the event, so a tag that is later renamed, merged or
    // deleted still reads correctly in the history of what was done that day.
    case "tag.applied":
      return { subject, verb: "tagged", object: tagTargetLabel(item, docTitle), suffix: `as ${tagNameLabel(item)}` };
    case "tag.removed":
      return { subject, verb: "untagged", object: tagTargetLabel(item, docTitle), suffix: `(${tagNameLabel(item)})` };
    case "request_repo.created":
      return { subject, verb: "created request inbox", object: item.project?.name?.trim() || docTitle, suffix: null };
    case "request.upload_received":
      return { subject: user || "Someone", verb: "submitted a document to", object: projectName, suffix: "via request link" };
    // Who is in the workspace. The target is carried in meta rather than looked up, so the sentence
    // still reads correctly after that person's account is gone.
    case "member.invited": {
      const who = metaString(item.meta, "email") || "someone";
      const role = metaString(item.meta, "role");
      return { subject, verb: "invited", object: who, suffix: role && role !== "member" ? `as ${role}` : null };
    }
    case "member.joined": {
      const who = user || metaString(item.meta, "email") || "Someone";
      const role = metaString(item.meta, "role");
      return { subject: who, verb: "joined", object: "this workspace", suffix: role && role !== "member" ? `as ${role}` : null };
    }
    case "member.removed": {
      const who = metaString(item.meta, "name") || metaString(item.meta, "email") || "a member";
      return { subject, verb: "removed", object: who, suffix: "from this workspace" };
    }
    case "member.left": {
      const who = user || metaString(item.meta, "name") || metaString(item.meta, "email") || "Someone";
      return { subject: who, verb: "left", object: "this workspace", suffix: null };
    }
    case "integration.slack_connected": {
      const channel = metaString(item.meta, "channelName") || "a channel";
      return { subject: user || "Someone", verb: "connected Slack", object: channel, suffix: null };
    }
    case "integration.slack_disconnected": {
      const channel = metaString(item.meta, "channelName") || "a channel";
      return { subject: user || "Someone", verb: "disconnected Slack", object: channel, suffix: null };
    }
    case "project.landed": {
      // No document: this is the arrival on the file list, and the reader may have opened nothing.
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      return { subject: who, verb: "opened", object: projectLabel(item), suffix: linkSuffix(item.meta, { alreadyNamesProject: true }) };
    }
    case "viewer.introduced": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      const changed = item.meta?.changed === true;
      const email = metaString(item.meta, "viewerEmail");
      return {
        subject: who,
        verb: changed ? "updated who they are on" : "introduced themselves on",
        object: item.doc?.title?.trim() ? docTitle : projectLabel(item),
        // The address is the point of the event — it is what the sender can actually reply to.
        suffix: email && email !== who ? email : null,
      };
    }
    case "share.unlocked": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      // The object is whatever the link opens: a document, or the whole room.
      const what = item.doc?.title?.trim() ? docTitle : item.project?.name?.trim() || metaString(item.meta, "projectName") || "a shared link";
      return { subject: who, verb: "entered the password for", object: what, suffix: linkSuffix(item.meta) };
    }
    case "share.viewed": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      return { subject: who, verb: "viewed", object: docTitle, suffix: linkSuffix(item.meta) };
    }
    case "share.downloaded": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      return { subject: who, verb: "downloaded", object: docTitle, suffix: linkSuffix(item.meta) };
    }
    case "share.visit_briefed": {
      const who = user || metaString(item.meta, "viewerName") || metaString(item.meta, "viewerEmail") || "Someone";
      // The object is whatever they sat with: a document, or the whole room.
      const what = item.doc?.title?.trim() ? docTitle : item.project?.name?.trim() || metaString(item.meta, "projectName") || "a shared link";
      const headline = metaString(item.meta, "headline");
      const duration = metaString(item.meta, "duration");
      return {
        subject: who,
        verb: "finished reading",
        object: what,
        suffix: headline ? `· ${headline}` : duration ? `(${duration})` : linkSuffix(item.meta),
      };
    }
    case "download_request.created":
      return { subject: email || "Someone", verb: "requested to download", object: docTitle, suffix: linkSuffix(item.meta) };
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
    case "agent.authorized": {
      const name = metaString(item.meta, "name") || "an agent";
      const workspace = metaString(item.meta, "workspace");
      return { subject: user || "Someone", verb: "connected", object: `“${name}”`, suffix: workspace ? `to ${workspace} by signing in` : "by signing in" };
    }
    case "agent.disconnected": {
      const name = metaString(item.meta, "name") || "an agent";
      return { subject: user || "Someone", verb: "disconnected", object: `“${name}”`, suffix: null };
    }
    case "agent.connected": {
      const client = item.agent?.label || metaString(item.meta, "client") || "An agent";
      const keyName = metaString(item.meta, "name");
      return { subject: client, verb: "connected to", object: "this workspace", suffix: keyName ? `using “${keyName}”` : null };
    }
    case "plan.limit_reached": {
      // meta.limit is the LimitKey ("documents", "projects", …); name the wall that was hit. The
      // feature gates are Pro features rather than caps, and read as such.
      const limit = metaString(item.meta, "limit") ?? "";
      const wall =
        limit === "documents"
          ? "the document limit"
          : limit === "projects"
            ? "the project limit"
            : limit === "collaborators"
              ? "the collaborator limit"
              : limit === "team_workspaces"
                ? "the workspace limit"
                : limit === "version_history"
                  ? "a Pro feature: version history"
                  : limit === "analytics_history"
                    ? "a Pro feature: deep analytics"
                    : limit === "project_links"
                      ? "a Pro feature: project links"
                      : "a plan limit";
      const target = item.doc?.title?.trim() ? `sharing ${docTitle}` : item.project?.name?.trim() ? `on ${item.project.name.trim()}` : "";
      return { subject, verb: `hit ${wall}`, object: target, suffix: null };
    }
    case "funnel.modal_shown": {
      const reason = metaString(item.meta, "reason");
      const from = metaString(item.meta, "from");
      return { subject, verb: "saw the upgrade prompt", object: reason ? `for ${reason.replace(/_/g, " ")}` : "", suffix: from ? `from ${from.replace(/_/g, " ")}` : null };
    }
    case "funnel.cta_clicked": {
      const cta = metaString(item.meta, "cta") ?? "";
      const reason = metaString(item.meta, "reason");
      const verb =
        cta === "upgrade" ? "chose Upgrade" : cta === "pack" ? "chose a credit pack" : cta === "compare" ? "opened Compare plans" : cta === "manage" ? "opened credit settings" : "dismissed the upgrade prompt";
      return { subject, verb, object: reason ? `for ${reason.replace(/_/g, " ")}` : "", suffix: null };
    }
    case "funnel.teaser_shown": {
      const raw = item.meta?.uniqueViewers;
      const readers = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      return {
        subject,
        verb: "saw the analytics teaser",
        object: readers !== null ? `counting ${readers} ${readers === 1 ? "reader" : "readers"}` : "",
        suffix: null,
      };
    }
    case "checkout.started": {
      const kind = metaString(item.meta, "kind");
      const interval = metaString(item.meta, "interval");
      const credits = metaString(item.meta, "credits");
      if (kind === "credit_pack") return { subject, verb: "started checkout for", object: credits ? `${credits} credits` : "a credit pack", suffix: null };
      return { subject, verb: "started checkout for", object: interval === "year" ? "Pro, yearly" : "Pro", suffix: null };
    }
    case "plan.grace_started":
      return { subject: "This workspace", verb: "entered its grace period", object: "", suffix: "over the Free limits at launch" };
    case "plan.grace_reminder":
      return { subject: "Grace period", verb: "ends soon for", object: "this workspace", suffix: null };
    case "plan.grace_blocked":
      return { subject: "Grace period", verb: "ended for", object: "this workspace", suffix: "Free limits now apply" };
    case "plan.upgraded":
      return { subject, verb: "upgraded", object: "this workspace", suffix: "to Pro" };
    case "plan.subscription_ending": {
      const periodEnd = metaString(item.meta, "periodEnd");
      const otherAdmins = Number(metaString(item.meta, "otherAdmins") ?? 0);
      // Another owner/admin remains: billing carries on, but the card belongs to the leaver.
      if (otherAdmins > 0) {
        return {
          subject: "Pro billing",
          verb: "needs a new payment method for",
          object: "this workspace",
          suffix: "the account whose card pays for it is being deleted; update it from Billing",
        };
      }
      return {
        subject: "Pro",
        verb: "ends for",
        object: "this workspace",
        suffix: periodEnd ? `at the end of the paid period (${periodEnd.slice(0, 10)}): the account that paid for it is being deleted` : "the account that paid for it is being deleted",
      };
    }
    case "summary.generated": {
      // A skipped summary written later (doc page action or the monthly re-queue).
      const by = agentSummarySuffix(item.meta);
      const failed = metaString(item.meta, "summary") !== "done";
      return { subject, verb: failed ? "could not write the AI summary for" : "wrote the AI summary for", object: docTitle, suffix: by };
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
