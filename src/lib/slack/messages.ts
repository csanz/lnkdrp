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

export function slackTestMessage(input: { workspaceName: string; channelName: string; appUrl: string }): SlackMessage {
  const text = `LinkDrop is connected to ${input.channelName} for ${input.workspaceName}. Opens, visit briefs, replaced documents, received files and new documents will show up here.`;
  return {
    text,
    blocks: twoBlocks(
      `*LinkDrop is connected to ${mrkdwn(input.channelName)}* for ${mrkdwn(input.workspaceName)}.\nOpens, visit briefs, replaced documents, received files and new documents will show up here.`,
      `Change what posts, or the channel, under <${input.appUrl}/integrations/slack|Integrations>.`,
    ),
  };
}

export function slackBurstMessage(input: { held: number; cap: number }): SlackMessage {
  const text = `…and ${input.held} more in the last minute. LinkDrop posts at most ${input.cap} a minute here; the rest follow shortly.`;
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

async function docTitle(orgId: Types.ObjectId, docId: Types.ObjectId | null): Promise<{ title: string; receivedVia: string | null } | null> {
  if (!docId) return null;
  const doc = (await DocModel.findOne({ _id: docId, orgId, isDeleted: { $ne: true } }).select({ title: 1, receivedViaRequestProjectId: 1 }).lean()) as
    | { title?: string; receivedViaRequestProjectId?: unknown }
    | null;
  if (!doc) return null;
  return { title: (doc.title ?? "").trim() || "Untitled document", receivedVia: doc.receivedViaRequestProjectId ? String(doc.receivedViaRequestProjectId) : null };
}

async function linkName(shareId: string | null): Promise<string> {
  if (!shareId) return DEFAULT_LINK_LABEL;
  const link = (await ShareLinkModel.findOne({ shareId }).select({ shareId: 1, label: 1, audience: 1, isDefault: 1 }).lean()) as
    | { label?: string; audience?: string | null; isDefault?: boolean }
    | null;
  if (!link) return DEFAULT_LINK_LABEL;
  return linkDisplayName({ shareId, label: link.label ?? null, audience: link.audience ?? null, isDefault: Boolean(link.isDefault), createdDate: null });
}

export async function renderSlackEvent(row: SlackOutbox): Promise<SlackMessage | null> {
  const orgId = row.orgId as Types.ObjectId;
  const ev = row.event ?? {};
  const f = await facts(orgId);
  switch (row.kind) {
    case "views": {
      const doc = await docTitle(orgId, (ev.docId as Types.ObjectId | null) ?? null);
      if (!doc) return null;
      const who = readerName(f.pro, ev.viewerName, ev.viewerEmail);
      const via = await linkName(ev.shareId ?? null);
      const docUrl = `${f.appUrl}/doc/${String(ev.docId)}`;
      const readerUrl = readerPage(f, { docId: (ev.docId as Types.ObjectId | null) ?? null, projectId: (ev.projectId as Types.ObjectId | null) ?? null, viewerKey: ev.viewerKey });
      const text = `${who} opened ${doc.title} via ${via}.`;
      return {
        text,
        blocks: twoBlocks(`${readerMark(who, readerUrl)} opened <${docUrl}|${mrkdwn(doc.title)}>`, `via ${mrkdwn(via)} · <${readerUrl ?? `${docUrl}/metrics`}|${readerUrl ? "this reader" : "see who's reading"}>`),
      };
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
      const who = readerName(f.pro, brief.viewerName ?? ev.viewerName, brief.viewerEmail ?? ev.viewerEmail);
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
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*${mrkdwn(who)} finished reading <${readerUrl}|${mrkdwn(title)}>*\n*${mrkdwn(headline)}*${body ? `\n${mrkdwn(body)}` : ""}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: `${howFar ? `${mrkdwn(howFar)} · ` : ""}<${readerUrl}|the visit>` }] },
          ],
        };
      }
      const text = `${who} finished reading ${title}${howFar ? ` (${howFar})` : ""}.`;
      return { text, blocks: twoBlocks(`${readerMark(who, readerPageUrl)} finished reading <${docUrl}|${mrkdwn(title)}>`, `${howFar ? `${mrkdwn(howFar)} · ` : ""}<${readerUrl}|the visit>`) };
    }
    case "docUpdates": {
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
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
      return {
        text,
        blocks: twoBlocks(`*<${docUrl}|${mrkdwn(doc.title)}>* was replaced${version ? `, now v${version}` : ""}${summary ? `\n${mrkdwn(summary)}` : ""}`, `Every link keeps working and shows the new version · <${docUrl}/history|what changed>`),
      };
    }
    case "docs": {
      // A document filed into a project: the room's channel (or the default) hears it landed.
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
      const projectId = (ev.projectId as Types.ObjectId | null) ?? null;
      const doc = await docTitle(orgId, docId);
      if (!doc || !docId) return null;
      const project = projectId ? ((await ProjectModel.findOne({ _id: projectId, orgId }).select({ name: 1, slug: 1 }).lean()) as { name?: string; slug?: string } | null) : null;
      const room = (project?.name ?? "").trim() || "a project";
      const docUrl = `${f.appUrl}/doc/${String(docId)}`;
      const roomUrl = project?.slug ? `${f.appUrl}/project/${encodeURIComponent(project.slug)}` : projectId ? `${f.appUrl}/project/${String(projectId)}` : null;
      const text = `${doc.title} was added to ${room}.`;
      return {
        text,
        blocks: twoBlocks(`*<${docUrl}|${mrkdwn(doc.title)}>* was added to ${roomUrl ? `*<${roomUrl}|${mrkdwn(room)}>*` : `*${mrkdwn(room)}*`}`, `Everyone with the room's link sees it now · <${docUrl}|open it>`),
      };
    }
    case "requests": {
      const docId = (ev.docId as Types.ObjectId | null) ?? null;
      const uploadId = (ev.uploadId as Types.ObjectId | null) ?? null;
      const doc = await docTitle(orgId, docId);
      if (!doc || !docId) return null;
      const upload = uploadId ? ((await UploadModel.findOne({ _id: uploadId, orgId }).select({ originalFileName: 1 }).lean()) as { originalFileName?: string } | null) : null;
      const fileName = (upload?.originalFileName ?? "").trim() || doc.title;
      const project = doc.receivedVia ? ((await ProjectModel.findOne({ _id: new Types.ObjectId(doc.receivedVia), orgId }).select({ name: 1 }).lean()) as { name?: string } | null) : null;
      const inbox = (project?.name ?? "").trim() || "a request inbox";
      const docUrl = `${f.appUrl}/doc/${String(docId)}`;
      const text = `${fileName} was received in ${inbox}.`;
      return { text, blocks: twoBlocks(`*<${docUrl}|${mrkdwn(fileName)}>* was received in *${mrkdwn(inbox)}*`, `<${docUrl}|open it>`) };
    }
    default:
      return null;
  }
}

/** For tests and previews: the real link label a message would print. */
export { realLinkLabel };
