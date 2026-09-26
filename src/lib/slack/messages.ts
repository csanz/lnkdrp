/**
 * What LinkDrop says in Slack (docs/prds/lnkdrp-slack.md, decisions 6 and 8).
 *
 * Every message is Block Kit with a plain-text twin: one header line, one context line, one link,
 * and never a Slack mention (a reader's name is text). The facts are loaded at post time from the
 * same rows the email round builders read, under the same plan gate: on Free a reader has no
 * identity, so the message says "Someone", exactly as the view email does.
 *
 * `renderSlackEvent` answers `null` when the source is gone (a deleted document, a purged brief),
 * and the outbox marks the row skipped rather than posting a message about nothing.
 */
import { Types } from "mongoose";

import { isProSubscription } from "@/lib/billing/subscriptionState";
import { DocModel } from "@/lib/models/Doc";
import { DocChangeModel } from "@/lib/models/DocChange";
import { ProjectModel } from "@/lib/models/Project";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { UploadModel } from "@/lib/models/Upload";
import { VisitBriefModel } from "@/lib/models/VisitBrief";
import { publicBaseUrl } from "@/lib/notifications/sendNotificationEmails";
import { formatDuration, linkDisplayName, realLinkLabel } from "@/lib/notifications/viewNotifications";
import { splitProjectViewerKey } from "@/lib/analytics/project/viewerKey";
import { viewerPageHref } from "@/lib/metrics/viewerRouteKey";
import { DEFAULT_LINK_LABEL } from "@/lib/share/links";
import { resolveReaderIdentity } from "@/lib/share/readerIdentity";
import type { SlackOutbox } from "@/lib/models/SlackOutbox";
import type { SlackMessage } from "./post";

/** Slack's mrkdwn treats these three as markup; escape them in anything a person typed. */
export function mrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function twoBlocks(headline: string, context: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: headline } },
    { type: "context", elements: [{ type: "mrkdwn", text: context }] },
  ];
}

/**
 * The two colours, and the line between them.
 *
 * A channel of these messages had no hierarchy: "Ana Lima opened Fundraising memo" and "Round terms
 * was added · 1 page" were the same weight, the same blue, the same grey second line, so the event
 * the product exists for was as easy to scroll past as a file upload. Slack groups consecutive posts
 * from one app and hides the icon after the first, so nothing else in the message was going to carry
 * that difference.
 *
 * The split is the PRD's own: the channel is for what *recipients* do (decision 5). Anything a
 * recipient did — opened it, said who they are, finished reading, sent a file back — is the product's
 * accent green, the same one the charts use. Anything the workspace did to its own documents —
 * added, replaced, a new link — is grey and recedes. Two colours and not five: a legend nobody asked
 * for is not a hierarchy, and the point is that one class jumps out, which stops being true as soon
 * as everything is coloured.
 *
 * Exported, colours and emoji together, because the homepage shot composes this channel rather than
 * photographing one (`scripts/home-shot-slack.ts`). A marketing picture that quietly disagrees with
 * the product is worse than no picture, so there is one definition and two readers.
 */
export const SLACK_MARKS = {
  /** What a recipient did: the product's own accent, the one the charts use. */
  recipient: "#0f9f6e",
  /** What the workspace did to its own documents. Recedes. */
  workspace: "#6b7280",
  opened: ":eyes:",
  introduced: ":wave:",
  brief: ":book:",
  received: ":incoming_envelope:",
  added: ":page_facing_up:",
  replaced: ":arrows_counterclockwise:",
  newLink: ":link:",
  /** A project, by the one distinction the app itself draws between them. */
  room: ":file_folder:",
  inbox: ":inbox_tray:",
} as const;

const RECIPIENT = SLACK_MARKS.recipient;
const WORKSPACE = SLACK_MARKS.workspace;

/**
 * One event, decorated.
 *
 * The emoji goes on the headline block and never into `text`: Slack reads `text` alone for mobile
 * notifications and screen readers, where a leading emoji is noise read aloud before the sentence.
 */
function event(input: { color: string; emoji: string; text: string; headline: string; context: string }): SlackMessage {
  return { text: input.text, color: input.color, blocks: twoBlocks(`${input.emoji} ${input.headline}`, input.context) };
}

export function slackTestMessage(input: { workspaceName: string; channelName: string; appUrl: string }): SlackMessage {
  const text = `LinkDrop is connected to ${input.channelName} for ${input.workspaceName}. Opens, visit briefs, replaced documents, received files and new documents will show up here.`;
  // Carries the accent, so the button that proves the connection also shows what an event will
  // look like when one arrives.
  return {
    text,
    color: RECIPIENT,
    blocks: twoBlocks(
      `${SLACK_MARKS.introduced} *LinkDrop is connected to ${mrkdwn(input.channelName)}* for ${mrkdwn(input.workspaceName)}.\nOpens, visit briefs, replaced documents, received files and new documents will show up here.`,
      `Change what posts, or the channel, under <${input.appUrl}/integrations/slack|Integrations>.`,
    ),
  };
}

export function slackBurstMessage(input: { held: number; cap: number }): SlackMessage {
  const text = `…and ${input.held} more in the last minute. LinkDrop posts at most ${input.cap} a minute here; the rest follow shortly.`;
  // Uncoloured on purpose: this is the channel talking about itself, not an event, and a bar here
  // would give housekeeping the same standing as the things that actually happened.
  return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: mrkdwn(text) }] }] };
}

// ---------------------------------------------------------------------------------------------
// The four events
// ---------------------------------------------------------------------------------------------

type Facts = {
  appUrl: string;
  pro: boolean;
};

async function facts(orgId: Types.ObjectId): Promise<Facts> {
  const sub = (await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1, kind: 1 }).lean()) as { status?: unknown; kind?: unknown } | null;
  return { appUrl: publicBaseUrl() || "http://localhost:3001", pro: isProSubscription(sub) };
}

/** The reader as the plan allows: name, else email, else "Someone"; always "Someone" on Free. */
function readerName(pro: boolean, name: string | null | undefined, email: string | null | undefined): string {
  if (!pro) return "Someone";
  const n = (name ?? "").trim();
  if (n) return clip(n, 80);
  const e = (email ?? "").trim();
  return e ? clip(e, 80) : "Someone";
}

/**
 * The reader's own page (`/doc/:id/metrics/viewer/:key`, or the project twin when the reading came
 * through a data-room link). Only when the plan shows identity: on Free the name is "Someone" and
 * the page would show nothing the message does not already say.
 */
function readerPage(f: Facts, args: { docId: Types.ObjectId | null; projectId: Types.ObjectId | null; viewerKey: string | null | undefined; viewerUserId?: string | null }): string | null {
  if (!f.pro) return null;
  const key = args.viewerUserId ?? (args.viewerKey ? splitProjectViewerKey(args.viewerKey).botIdHash : "");
  if (!key) return null;
  return viewerPageHref({ appUrl: f.appUrl, projectId: args.projectId ? String(args.projectId) : null, docId: args.docId ? String(args.docId) : null, kind: args.viewerUserId ? "authed" : "anon", key });
}

/** The reader as a link to their page when there is one, else plain bold text. */
function readerMark(who: string, url: string | null): string {
  return url ? `*<${url}|${mrkdwn(who)}>*` : `*${mrkdwn(who)}*`;
}

async function docTitle(orgId: Types.ObjectId, docId: Types.ObjectId | null): Promise<{ title: string; receivedVia: string | null; pages: number | null } | null> {
  if (!docId) return null;
  const doc = (await DocModel.findOne({ _id: docId, orgId, isDeleted: { $ne: true } }).select({ title: 1, receivedViaRequestProjectId: 1, "slideNodes.pageNumber": 1 }).lean()) as
    | { title?: string; receivedViaRequestProjectId?: unknown; slideNodes?: unknown[] }
    | null;
  if (!doc) return null;
  const pages = Array.isArray(doc.slideNodes) && doc.slideNodes.length > 0 ? doc.slideNodes.length : null;
  return { title: (doc.title ?? "").trim() || "Untitled document", receivedVia: doc.receivedViaRequestProjectId ? String(doc.receivedViaRequestProjectId) : null, pages };
}

/**
 * A project's mark: the folder or the inbox tray, before its name.
 *
 * Projects have no icon of their own anywhere in the product — the sidebar draws every one of them
 * with the same folder glyph — so this is not reading a stored choice, it is the same two-way
 * distinction the app already makes: `isRequest` separates a data room from a request inbox, and
 * those are different enough that a message saying "was added to" should not look identical for
 * both. If projects ever gain a chosen emoji, this is the one function that changes.
 */
function roomEmoji(isRequest: boolean | undefined): string {
  return isRequest ? SLACK_MARKS.inbox : SLACK_MARKS.room;
}

/** A room as it appears inside a sentence: its mark, then its name, linked when there is a URL. */
function roomMark(room: { name: string; isRequest?: boolean }, url: string | null): string {
  const name = url ? `<${url}|${mrkdwn(room.name)}>` : mrkdwn(room.name);
  return `${roomEmoji(room.isRequest)} *${name}*`;
}

async function projectName(orgId: Types.ObjectId, projectId: Types.ObjectId | null): Promise<{ name: string; isRequest: boolean } | null> {
  if (!projectId) return null;
  const project = (await ProjectModel.findOne({ _id: projectId, orgId }).select({ name: 1, isRequest: 1 }).lean()) as { name?: string; isRequest?: boolean } | null;
  if (!project) return null;
  return { name: (project.name ?? "").trim() || "a data room", isRequest: Boolean(project.isRequest) };
}

async function linkName(shareId: string | null): Promise<string> {
  if (!shareId) return DEFAULT_LINK_LABEL;
  const link = (await ShareLinkModel.findOne({ shareId }).select({ shareId: 1, label: 1, audience: 1, isDefault: 1 }).lean()) as
    | { label?: string; audience?: string | null; isDefault?: boolean }
    | null;
  if (!link) return DEFAULT_LINK_LABEL;
  return linkDisplayName({ shareId, label: link.label ?? null, audience: link.audience ?? null, isDefault: Boolean(link.isDefault), createdDate: null });
}

/**
 * "Elena Ruiz introduced themselves on Data room via Sequoia Capital". The one recipient event
 * that stays visible on Free: the name was volunteered to this workspace (the feed says the same).
 */
async function renderIntroduction(f: Facts, orgId: Types.ObjectId, ev: NonNullable<SlackOutbox["event"]>): Promise<SlackMessage | null> {
  const name = (ev.viewerName ?? "").trim();
  const email = (ev.viewerEmail ?? "").trim();
  const who = clip(name || email || "Someone", 80);
  const projectId = (ev.projectId as Types.ObjectId | null) ?? null;
  const docId = (ev.docId as Types.ObjectId | null) ?? null;
  let place = "a document";
  let url = `${f.appUrl}/activity`;
  /** The room's mark when they arrived in one; a document has the message's own emoji already. */
  let placeMark: string | null = null;
  if (projectId) {
    const project = await projectName(orgId, projectId);
    if (!project) return null;
    place = project.name;
    url = `${f.appUrl}/project/${String(projectId)}`;
    placeMark = roomMark(project, url);
  } else if (docId) {
    const doc = await docTitle(orgId, docId);
    if (!doc) return null;
    place = doc.title;
    url = `${f.appUrl}/doc/${String(docId)}`;
  }
  const via = await linkName(ev.shareId ?? null);
  const readerUrl = viewerPageHref({ appUrl: f.appUrl, projectId: projectId ? String(projectId) : null, docId: docId ? String(docId) : null, kind: "anon", key: ev.viewerKey ? splitProjectViewerKey(ev.viewerKey).botIdHash : "" });
  const text = `${who} introduced themselves on ${place} via ${via}.${name && email ? ` ${email}` : ""}`;
  return event({
    color: RECIPIENT,
    emoji: SLACK_MARKS.introduced,
    text,
    headline: `${readerMark(who, readerUrl)} introduced themselves on ${placeMark ?? `<${url}|${mrkdwn(place)}>`}${name && email ? `
${mrkdwn(email)}` : ""}`,
    context: `via ${mrkdwn(via)}${readerUrl ? ` · <${readerUrl}|this reader>` : ""}`,
  });
}

export async function renderSlackEvent(row: SlackOutbox): Promise<SlackMessage | null> {
  const orgId = row.orgId as Types.ObjectId;
  const ev: NonNullable<SlackOutbox["event"]> = row.event ?? ({} as NonNullable<SlackOutbox["event"]>);
  const f = await facts(orgId);
  switch (row.kind) {
    case "views": {
      if (ev.introduced) return renderIntroduction(f, orgId, ev);
      const doc = await docTitle(orgId, (ev.docId as Types.ObjectId | null) ?? null);
      if (!doc) return null;
      // The event carries what the timing post said; a data-room reader who introduced themselves on
      // the landing page said it there, on the share views. Pro only: Free never shows a name.
      const known = f.pro ? await resolveReaderIdentity(ev.shareId, ev.viewerKey, { viewerName: ev.viewerName, viewerEmail: ev.viewerEmail }) : {};
      const who = readerName(f.pro, known.viewerName ?? ev.viewerName, known.viewerEmail ?? ev.viewerEmail);
      const via = await linkName(ev.shareId ?? null);
      const docUrl = `${f.appUrl}/doc/${String(ev.docId)}`;
      const readerUrl = readerPage(f, { docId: (ev.docId as Types.ObjectId | null) ?? null, projectId: (ev.projectId as Types.ObjectId | null) ?? null, viewerKey: ev.viewerKey });
      const text = `${who} opened ${doc.title} via ${via}.`;
      return event({
        color: RECIPIENT,
        emoji: SLACK_MARKS.opened,
        text,
        headline: `${readerMark(who, readerUrl)} opened <${docUrl}|${mrkdwn(doc.title)}>`,
        context: `via ${mrkdwn(via)} · <${readerUrl ?? `${docUrl}/metrics`}|${readerUrl ? "this reader" : "see who's reading"}>`,
      });
    }
    case "briefs": {
      const briefId = (ev.visitBriefId as Types.ObjectId | null) ?? null;
      if (!briefId) return null;
      const brief = (await VisitBriefModel.findOne({ _id: briefId, orgId }).lean()) as
        | { status?: string; brief?: { headline?: string; body?: string } | null; docId?: unknown; projectId?: unknown; botIdHash?: string; viewerUserId?: unknown; viewerName?: string | null; viewerEmail?: string | null; stats?: { timeSpentMs?: number; pagesSeen?: number }; recapReason?: string | null }
        | null;
      if (!brief) return null;
      const doc = await docTitle(orgId, brief.docId ? new Types.ObjectId(String(brief.docId)) : ((ev.docId as Types.ObjectId | null) ?? null));
      const title = doc?.title ?? "a document";
      const knownReader = f.pro && !(brief.viewerName ?? ev.viewerName) ? await resolveReaderIdentity(ev.shareId, brief.botIdHash ?? ev.viewerKey, { viewerName: null, viewerEmail: brief.viewerEmail ?? ev.viewerEmail }) : {};
      const who = readerName(f.pro, brief.viewerName ?? ev.viewerName ?? knownReader.viewerName, brief.viewerEmail ?? ev.viewerEmail ?? knownReader.viewerEmail);
      const dur = formatDuration(Number(brief.stats?.timeSpentMs ?? 0));
      const pages = Number(brief.stats?.pagesSeen ?? 0);
      const howFar = [pages > 0 ? `${pages} page${pages === 1 ? "" : "s"}` : null, dur].filter(Boolean).join(" · ");
      const readerPageUrl = readerPage(f, {
        docId: brief.docId ? new Types.ObjectId(String(brief.docId)) : ((ev.docId as Types.ObjectId | null) ?? null),
        projectId: brief.projectId ? new Types.ObjectId(String(brief.projectId)) : ((ev.projectId as Types.ObjectId | null) ?? null),
        viewerKey: brief.botIdHash ?? ev.viewerKey,
        viewerUserId: brief.viewerUserId ? String(brief.viewerUserId) : null,
      });
      const readerUrl = readerPageUrl ?? `${f.appUrl}/activity`;
      const docUrl = `${f.appUrl}/doc/${String(brief.docId ?? ev.docId)}`;
      if (brief.status === "briefed" && brief.brief?.headline) {
        const headline = clip(brief.brief.headline.trim(), 140);
        const body = clip((brief.brief.body ?? "").trim(), 600);
        return {
          text: `${who} finished reading ${title}: ${headline}`,
          color: RECIPIENT,
          // The one message that is not two lines, and the most valuable in the channel: it keeps
          // its own shape (the headline in bold above the body) rather than being forced through
          // `event`.
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `${SLACK_MARKS.brief} *${mrkdwn(who)} finished reading <${readerUrl}|${mrkdwn(title)}>*\n*${mrkdwn(headline)}*${body ? `\n${mrkdwn(body)}` : ""}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: `${howFar ? `${mrkdwn(howFar)} · ` : ""}<${readerUrl}|the visit>` }] },
          ],
        };
      }
      const text = `${who} finished reading ${title}${howFar ? ` (${howFar})` : ""}.`;
      return event({
        color: RECIPIENT,
        emoji: SLACK_MARKS.brief,
        text,
        headline: `${readerMark(who, readerPageUrl)} finished reading <${docUrl}|${mrkdwn(title)}>`,
        context: `${howFar ? `${mrkdwn(howFar)} · ` : ""}<${readerUrl}|the visit>`,
      });
    }
    case "docUpdates": {
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
      const projectId = (ev.projectId as Types.ObjectId | null) ?? null;
      const docChange = (ev.change as string | null | undefined) ?? null;
      if (docChange === "link_created") {
        // A new share link: a document link when the row names a document, else a data-room link.
        const shareId = ev.shareId ?? null;
        if (!shareId) return null;
        const link = (await ShareLinkModel.findOne({ shareId }).select({ shareId: 1, label: 1, audience: 1, isDefault: 1 }).lean()) as
          | { label?: string; audience?: string | null; isDefault?: boolean }
          | null;
        if (!link) return null;
        const name = linkDisplayName({ shareId, label: link.label ?? null, audience: link.audience ?? null, isDefault: Boolean(link.isDefault), createdDate: null });
        const audience = clip((link.audience ?? "").trim(), 80);
        let title: string;
        let url: string;
        let more: string;
        /** What the link points at, marked: a room carries its folder, a document does not. */
        let targetMark: string;
        if (docId) {
          const doc = await docTitle(orgId, docId);
          if (!doc) return null;
          title = doc.title;
          url = `${f.appUrl}/doc/${String(docId)}`;
          more = `<${url}/links|all links>`;
          targetMark = `<${url}|${mrkdwn(title)}>`;
        } else {
          const room = await projectName(orgId, projectId);
          if (!room || !projectId) return null;
          title = room.name;
          url = `${f.appUrl}/project/${String(projectId)}`;
          more = `<${url}|open the ${room.isRequest ? "request inbox" : "data room"}>`;
          targetMark = roomMark(room, url);
        }
        const text = `New link ${name} for ${title}.`;
        return event({
          color: WORKSPACE,
          emoji: SLACK_MARKS.newLink,
          text,
          headline: `New link *${mrkdwn(name)}* for ${targetMark}`,
          context: `${audience ? `for ${mrkdwn(audience)} · ` : ""}${more}`,
        });
      }
      const doc = await docTitle(orgId, docId);
      if (!doc || !docId) return null;
      const uploadId = (ev.uploadId as Types.ObjectId | null) ?? null;
      const change = uploadId
        ? ((await DocChangeModel.findOne({ orgId, toUploadId: uploadId }).select({ "diff.summary": 1, toVersion: 1 }).lean()) as { diff?: { summary?: string }; toVersion?: number } | null)
        : null;
      const version = typeof ev.version === "number" ? ev.version : typeof change?.toVersion === "number" ? change.toVersion : null;
      const summary = clip((change?.diff?.summary ?? "").trim(), 300);
      const docUrl = `${f.appUrl}/doc/${String(docId)}`;
      const text = `${doc.title} was replaced${version ? ` (v${version})` : ""}.${summary ? ` ${summary}` : ""}`;
      return event({
        color: WORKSPACE,
        emoji: SLACK_MARKS.replaced,
        text,
        headline: `*<${docUrl}|${mrkdwn(doc.title)}>* was replaced${version ? `, now v${version}` : ""}${summary ? `\n${mrkdwn(summary)}` : ""}`,
        context: `Every link keeps working and shows the new version · <${docUrl}/history|what changed>`,
      });
    }
    case "docs": {
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
      const projectId = (ev.projectId as Types.ObjectId | null) ?? null;
      const doc = await docTitle(orgId, docId);
      if (!doc || !docId) return null;
      if (ev.change === "created") {
        // A new document finished processing: the title, the page count when the pages are in.
        const docUrl = `${f.appUrl}/doc/${String(docId)}`;
        const pages = doc.pages ? `${doc.pages} page${doc.pages === 1 ? "" : "s"}` : null;
        // Born in a room: say so, and link the room. Nothing else changes.
        const home = projectId ? await projectName(orgId, projectId) : null;
        const roomUrl = projectId ? `${f.appUrl}/project/${String(projectId)}` : null;
        const text = home ? `${doc.title} was added to ${home.name}.` : `${doc.title} was added.`;
        return event({
          color: WORKSPACE,
          emoji: SLACK_MARKS.added,
          text,
          headline: `*<${docUrl}|${mrkdwn(doc.title)}>* was added${home ? ` to ${roomMark(home, roomUrl)}` : ""}${pages ? ` · ${pages}` : ""}`,
          context: `<${docUrl}|open it> · <${docUrl}/metrics|metrics>`,
        });
      }
      // A document filed into a project: the room's channel (or the default) hears it landed.
      const project = projectId
        ? ((await ProjectModel.findOne({ _id: projectId, orgId }).select({ name: 1, slug: 1, isRequest: 1 }).lean()) as { name?: string; slug?: string; isRequest?: boolean } | null)
        : null;
      const room = { name: (project?.name ?? "").trim() || "a project", isRequest: Boolean(project?.isRequest) };
      const docUrl = `${f.appUrl}/doc/${String(docId)}`;
      const roomUrl = project?.slug ? `${f.appUrl}/project/${encodeURIComponent(project.slug)}` : projectId ? `${f.appUrl}/project/${String(projectId)}` : null;
      const text = `${doc.title} was added to ${room.name}.`;
      return event({
        color: WORKSPACE,
        emoji: SLACK_MARKS.added,
        text,
        headline: `*<${docUrl}|${mrkdwn(doc.title)}>* was added to ${roomMark(room, roomUrl)}`,
        context: `Everyone with the room's link sees it now · <${docUrl}|open it>`,
      });
    }
    case "requests": {
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
      const uploadId = (ev.uploadId as Types.ObjectId | null) ?? null;
      const doc = await docTitle(orgId, docId);
      if (!doc || !docId) return null;
      const upload = uploadId ? ((await UploadModel.findOne({ _id: uploadId, orgId }).select({ originalFileName: 1 }).lean()) as { originalFileName?: string } | null) : null;
      const fileName = (upload?.originalFileName ?? "").trim() || doc.title;
      const project = doc.receivedVia ? ((await ProjectModel.findOne({ _id: new Types.ObjectId(doc.receivedVia), orgId }).select({ name: 1 }).lean()) as { name?: string } | null) : null;
      // Always an inbox: the row exists because the file arrived through one, so the flag is not read.
      const inbox = { name: (project?.name ?? "").trim() || "a request inbox", isRequest: true };
      const inboxUrl = doc.receivedVia ? `${f.appUrl}/project/${doc.receivedVia}` : null;
      const docUrl = `${f.appUrl}/doc/${String(docId)}`;
      const text = `${fileName} was received in ${inbox.name}.`;
      // A recipient's colour, not the workspace's: a file landing in a request inbox is something
      // someone outside did, which is the half of the channel worth looking up for. The envelope
      // leads and the tray marks the inbox, so the two are not the same glyph twice in one line.
      return event({
        color: RECIPIENT,
        emoji: SLACK_MARKS.received,
        text,
        headline: `*<${docUrl}|${mrkdwn(fileName)}>* was received in ${roomMark(inbox, inboxUrl)}`,
        context: `<${docUrl}|open it>`,
      });
    }
    default:
      return null;
  }
}

/** For tests and previews: the real link label a message would print. */
export { realLinkLabel };
