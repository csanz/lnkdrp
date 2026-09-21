/**
 * Every email template rendered with fixed sample inputs — the bodies, from the real builders,
 * with made-up arguments.
 *
 * It lives here rather than inside the admin route because two things need it and they must not
 * drift: `GET /api/admin/emails/previews`, which shows an operator what each template says, and
 * `scripts/send-test-emails.ts`, which posts those same bodies to a real inbox so somebody can see
 * how they actually render in a mail client. A second set of fixtures written for the script would
 * be a second thing to keep true.
 *
 * Nothing here reads the database and nothing is sent. `now` is passed explicitly wherever a
 * builder would otherwise read the clock, so two renders are byte-identical and a diff in the
 * output is a diff in the template.
 */
import type { EmailContent } from "@/lib/email/templates/compose";
import {
  EMAIL_CATALOG,
  downloadRequestApprovedEmail,
  downloadRequestOwnerEmail,
  downloadRequestReceivedEmail,
  memberRemovedEmail,
  viewerIntroducedEmail,
  viewerVerifyEmail,
  waitlistApprovedEmail,
  welcomeEmail,
  orgInviteEmail,
} from "@/lib/email/templates";
import { buildPlanLimitEmail } from "@/lib/email/sendPlanLimitEmail";
import {
  composeDigestEmail,
  composeImmediateEmail,
  type ComposeContext,
  type NewViewerEvent,
  type ReturnEvent,
  type ViewDocInfo,
  type ViewLinkInfo,
} from "@/lib/notifications/viewNotifications";

type PreviewInput = { label: string; value: string };

export type PreviewRow = {
  /** Stable key for React and for deep-linking a single preview. */
  key: string;
  /** The `EMAIL_CATALOG` id this preview belongs to. */
  catalogId: string;
  label: string;
  inputs: PreviewInput[];
  subject: string;
  text: string;
  /** Only the share-view emails have an HTML part; the rest are text-only. */
  html: string | null;
  /** RFC 8058 one-click unsubscribe headers, on the emails that carry them. */
  headers: { name: string; value: string }[] | null;
};

// Fixed sample data, so two loads of the page render identically and a diff in the body is a diff
// in the template. `now` is also passed explicitly wherever a builder would otherwise read the clock.
const SITE_URL = "https://lnkdrp.com";
const SAMPLE_NOW = new Date("2026-09-17T09:40:00.000Z");
const SAMPLE_TITLE = "Series A deck";
const SAMPLE_SHARE_URL = `${SITE_URL}/p/ab12cd34`;
const SAMPLE_DOC_ID = "68c1f0a2b3c4d5e6f7a80001";

const SAMPLE_DOC: ViewDocInfo = { docId: SAMPLE_DOC_ID, title: SAMPLE_TITLE, pageCount: 18 };

const SAMPLE_LINK: ViewLinkInfo = {
  shareId: "ab12cd34",
  label: "Sequoia",
  audience: "Sequoia partners",
  isDefault: false,
  createdDate: new Date("2026-09-01T12:00:00.000Z"),
};

const SAMPLE_LINKS: ReadonlyMap<string, ViewLinkInfo> = new Map([[SAMPLE_LINK.shareId, SAMPLE_LINK]]);
const SAMPLE_DOCS: ReadonlyMap<string, ViewDocInfo> = new Map([[SAMPLE_DOC.docId, SAMPLE_DOC]]);

const SAMPLE_VIEW: NewViewerEvent = {
  kind: "view",
  id: "68c1f0a2b3c4d5e6f7a80101",
  docId: SAMPLE_DOC_ID,
  shareId: SAMPLE_LINK.shareId,
  shareLinkId: "68c1f0a2b3c4d5e6f7a80201",
  botIdHash: "sample-viewer-1",
  at: new Date("2026-09-17T09:12:00.000Z"),
  pagesSeen: 12,
  timeSpentMs: 4 * 60 * 1000,
  viewerUserId: null,
  viewerName: "Dana Marks",
  viewerEmail: "dana@example.com",
  viewerUserName: null,
};

const SAMPLE_VIEW_2: NewViewerEvent = {
  ...SAMPLE_VIEW,
  id: "68c1f0a2b3c4d5e6f7a80102",
  botIdHash: "sample-viewer-2",
  at: new Date("2026-09-17T08:05:00.000Z"),
  pagesSeen: 3,
  timeSpentMs: 45 * 1000,
  viewerName: null,
  viewerEmail: null,
};

const SAMPLE_RETURN: ReturnEvent = {
  kind: "return",
  id: "68c1f0a2b3c4d5e6f7a80103",
  docId: SAMPLE_DOC_ID,
  shareId: SAMPLE_LINK.shareId,
  shareLinkId: "68c1f0a2b3c4d5e6f7a80201",
  botIdHash: "sample-viewer-1",
  at: new Date("2026-09-17T09:30:00.000Z"),
  firstViewAt: new Date("2026-09-15T14:00:00.000Z"),
  firstVisitAt: new Date("2026-09-15T14:00:00.000Z"),
  pagesSeen: 18,
  timeSpentMs: 9 * 60 * 1000,
  viewerUserId: null,
  viewerName: "Dana Marks",
  viewerEmail: "dana@example.com",
  viewerUserName: null,
};

// A placeholder, not a minted token: `offUrl` is only interpolated into the body and the
// List-Unsubscribe header, so a preview does not need the notification token secret.
const SAMPLE_OFF_URL = `${SITE_URL}/api/notifications/views/off?t=preview`;

/** The compose context for a share-view email on one plan. */
function viewCtx(plan: "free" | "pro"): ComposeContext {
  return { appUrl: SITE_URL, offUrl: SAMPLE_OFF_URL, plan };
}

/** Mail headers as ordered pairs, so the page can render them without Object.entries. */
function headerRows(headers: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

const VIEW_EVENT_INPUTS: PreviewInput[] = [
  { label: "doc", value: `"${SAMPLE_TITLE}", 18 pages` },
  { label: "link", value: `${SAMPLE_LINK.shareId} — label "Sequoia", audience "Sequoia partners"` },
  { label: "offUrl", value: `${SAMPLE_OFF_URL} (placeholder, not a signed token)` },
];

/** Build every preview. Pure: no database, no network, no sending. */
/**
 * Spread a template's result into a preview row.
 *
 * `...someEmail(...)` followed by a literal `html: null` is what these rows used to be, and it
 * worked only while every template was text-only: the day they grew an HTML part, the null would
 * have thrown it away and the previews page would have kept showing text with nothing to say why.
 */
function content(c: EmailContent): { subject: string; text: string; html: string | null } {
  return { subject: c.subject, text: c.text, html: c.html ?? null };
}

export function buildPreviews(): PreviewRow[] {
  const rows: PreviewRow[] = [];

  // First in the list because it is the first email an account ever gets.
  rows.push({
    key: "welcome",
    catalogId: "welcome",
    label: "New account, at sign-up",
    inputs: [
      { label: "name", value: "Dana Lee" },
      { label: "appUrl", value: SITE_URL },
    ],
    ...content(welcomeEmail({ name: "Dana Lee", appUrl: SITE_URL })),
    headers: null,
  });

  // Google does not always give us a name, and the greeting has to survive that.
  rows.push({
    key: "welcome.no_name",
    catalogId: "welcome",
    label: "New account, with no name from Google",
    inputs: [
      { label: "name", value: "(empty)" },
      { label: "appUrl", value: SITE_URL },
    ],
    ...content(welcomeEmail({ name: null, appUrl: SITE_URL })),
    headers: null,
  });

  rows.push({
    key: "download_request.received",
    catalogId: "download_request.received",
    label: "Receipt to the requester",
    inputs: [
      { label: "title", value: SAMPLE_TITLE },
      { label: "shareUrl", value: SAMPLE_SHARE_URL },
    ],
    ...content(downloadRequestReceivedEmail({ title: SAMPLE_TITLE, shareUrl: SAMPLE_SHARE_URL })),
    headers: null,
  });

  rows.push({
    key: "download_request.owner",
    catalogId: "download_request.owner",
    label: "Approve / deny, to the owner",
    inputs: [
      { label: "title", value: SAMPLE_TITLE },
      { label: "shareUrl", value: SAMPLE_SHARE_URL },
      { label: "requesterEmail", value: "dana@example.com" },
      { label: "approveUrl", value: `${SITE_URL}/download-requests/approve/tok` },
      { label: "denyUrl", value: `${SITE_URL}/download-requests/deny/tok` },
    ],
    ...content(downloadRequestOwnerEmail({
      title: SAMPLE_TITLE,
      shareUrl: SAMPLE_SHARE_URL,
      requesterEmail: "dana@example.com",
      approveUrl: `${SITE_URL}/download-requests/approve/tok`,
      denyUrl: `${SITE_URL}/download-requests/deny/tok`,
    })),
    headers: null,
  });

  // Worth its own row: this is what recipients get when NEXT_PUBLIC_SITE_URL is unset in the
  // environment that sent the mail, and the links are unusable.
  rows.push({
    key: "download_request.owner.missing_site_url",
    catalogId: "download_request.owner",
    label: "Approve / deny, with NEXT_PUBLIC_SITE_URL unset",
    inputs: [
      { label: "title", value: "(empty)" },
      { label: "shareUrl", value: "(empty)" },
      { label: "requesterEmail", value: "dana@example.com" },
      { label: "approveUrl", value: "(empty)" },
      { label: "denyUrl", value: "(empty)" },
    ],
    ...content(downloadRequestOwnerEmail({
      title: "",
      shareUrl: "",
      requesterEmail: "dana@example.com",
      approveUrl: "",
      denyUrl: "",
    })),
    headers: null,
  });

  rows.push({
    key: "download_request.approved",
    catalogId: "download_request.approved",
    label: "Approved, with the claim link",
    inputs: [
      { label: "title", value: SAMPLE_TITLE },
      { label: "claimUrl", value: `${SITE_URL}/download/claim/tok` },
    ],
    ...content(downloadRequestApprovedEmail({ title: SAMPLE_TITLE, claimUrl: `${SITE_URL}/download/claim/tok` })),
    headers: null,
  });

  rows.push({
    key: "member_removed",
    catalogId: "member_removed",
    label: "Removed from a workspace",
    inputs: [
      { label: "orgName", value: "Acme" },
      { label: "removedByEmail", value: "owner@example.com" },
      { label: "appUrl", value: SITE_URL },
    ],
    ...content(memberRemovedEmail({ orgName: "Acme", removedByEmail: "owner@example.com", appUrl: SITE_URL })),
    headers: null,
  });

  rows.push({
    key: "org_invite",
    catalogId: "org_invite",
    label: "Invited to a workspace",
    inputs: [
      { label: "orgName", value: "Acme" },
      { label: "role", value: "editor" },
      { label: "invitedByEmail", value: "dana@example.com" },
    ],
    ...content(
      orgInviteEmail({
        orgName: "Acme",
        inviteUrl: `${SITE_URL}/invites/tok`,
        role: "editor",
        invitedByEmail: "dana@example.com",
      }),
    ),
    headers: null,
  });

  rows.push({
    key: "waitlist_approved",
    catalogId: "waitlist_approved",
    label: "Early access opened",
    inputs: [
      { label: "name", value: "Dana" },
      { label: "appUrl", value: SITE_URL },
    ],
    ...content(waitlistApprovedEmail({ name: "Dana", appUrl: SITE_URL })),
    headers: null,
  });

  rows.push({
    key: "viewer_verify",
    catalogId: "viewer_verify",
    label: "Reader confirms the address they typed",
    inputs: [
      { label: "documentTitle", value: SAMPLE_TITLE },
      { label: "workspaceName", value: "Acme" },
      { label: "verifyUrl", value: `${SITE_URL}/share/verify?t=tok` },
    ],
    ...content(viewerVerifyEmail({
      documentTitle: SAMPLE_TITLE,
      workspaceName: "Acme",
      verifyUrl: `${SITE_URL}/share/verify?t=tok`,
    })),
    headers: null,
  });

  // Both halves, because the sentence that matters is the one that changes: a confirmed address is
  // a fact and an unconfirmed one is a claim, and the owner has to be able to tell them apart.
  for (const verified of [true, false] as const) {
    rows.push({
      key: `viewer_introduced.${verified ? "verified" : "claimed"}`,
      catalogId: "viewer_introduced",
      label: `Reader introduced themselves — ${verified ? "confirmed" : "unconfirmed"}`,
      inputs: [
        { label: "verified", value: String(verified) },
        { label: "viewerName", value: "Dana Lee" },
        { label: "viewerEmail", value: "dana@example.com" },
        { label: "documentTitle", value: SAMPLE_TITLE },
      ],
      ...content(viewerIntroducedEmail({
        documentTitle: SAMPLE_TITLE,
        viewerName: "Dana Lee",
        viewerEmail: "dana@example.com",
        verified,
        metricsUrl: `${SITE_URL}/doc/${SAMPLE_DOC_ID}/metrics`,
      })),
      headers: null,
    });
  }

  const planUsage = { documents: 7, projects: 2, members: 3 };
  const graceEndsAt = new Date("2026-09-26T00:00:00.000Z");
  for (const kind of ["started", "reminder", "blocked"] as const) {
    rows.push({
      key: `plan_limit.${kind}`,
      catalogId: "plan_limit",
      label: `Plan limit — ${kind}`,
      inputs: [
        { label: "kind", value: kind },
        { label: "workspaceName", value: "Acme" },
        { label: "usage", value: "7 documents, 2 projects, 3 members" },
        { label: "endsAt", value: graceEndsAt.toISOString() },
        { label: "now", value: SAMPLE_NOW.toISOString() },
      ],
      ...content(buildPlanLimitEmail({
        to: "owner@example.com",
        kind,
        workspaceName: "Acme",
        usage: planUsage,
        endsAt: graceEndsAt,
        pricingUrl: `${SITE_URL}/pricing`,
        now: SAMPLE_NOW,
      })),
      headers: null,
    });
  }

  // Free and Pro are genuinely different emails: Pro names the viewer and says how far they read,
  // Free says which link and when. Both are previewed so the difference is visible.
  for (const plan of ["free", "pro"] as const) {
    const immediate = composeImmediateEmail({
      ctx: viewCtx(plan),
      doc: SAMPLE_DOC,
      events: [SAMPLE_VIEW, SAMPLE_VIEW_2],
      links: SAMPLE_LINKS,
    });
    rows.push({
      key: `share_views.immediate.${plan}`,
      catalogId: "share_views.immediate",
      label: `Share view — immediate (${plan})`,
      inputs: [
        { label: "plan", value: plan },
        { label: "events", value: "2 new viewers on one link" },
        ...VIEW_EVENT_INPUTS,
      ],
      subject: immediate.subject,
      text: immediate.text,
      html: immediate.html,
      headers: headerRows(immediate.headers),
    });

    const digest = composeDigestEmail({
      ctx: viewCtx(plan),
      docs: SAMPLE_DOCS,
      views: [SAMPLE_VIEW, SAMPLE_VIEW_2],
      returns: [SAMPLE_RETURN],
      links: SAMPLE_LINKS,
      period: "today",
    });
    rows.push({
      key: `share_views.daily.${plan}`,
      catalogId: "share_views.daily",
      label: `Share view — daily digest (${plan})`,
      inputs: [
        { label: "plan", value: plan },
        { label: "views", value: "2 new viewers" },
        { label: "returns", value: "1 returning reader" },
        { label: "period", value: "today" },
        ...VIEW_EVENT_INPUTS,
      ],
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
      headers: headerRows(digest.headers),
    });
  }

  return rows;
}

/** Handle GET requests. */
