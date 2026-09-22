/**
 * API route: GET / POST `/api/notifications/views/off?t=<token>`
 *
 * One-click "Turn off these emails" from a view notification email
 * (docs/prds/lnkdrp-view-notifications.md, decision 8). No sign-in: the signed token
 * (`@/lib/notifications/viewEmailToken`) is the authority, because the email is usually
 * opened on a phone where the member is not signed in.
 *
 * **GET never writes.** It used to: one GET of a valid token set `viewEmailMode` to `off`. But this
 * URL is not only in the `List-Unsubscribe` header, it is rendered into the visible footer of every
 * view email (plain text and as an anchor), so anything that opens links in a mail body — a
 * corporate link scanner, an antivirus proxy, a prefetching client, a forwarded copy of the mail —
 * silently disabled a member's view notifications, and nothing in the app said why they had stopped.
 * GET now renders the state plus a confirm button that POSTs; the write lives on POST alone.
 *
 * - Valid token: show the current mode and a confirm form (already `off`: just say so). No write.
 * - Expired but correctly signed: change nothing, show the current state and the preferences link.
 * - Malformed / bad signature / wrong purpose: a neutral "not valid" page, status 400.
 *
 * The page only ever shows the token's own membership (its workspace name and mode), nothing
 * about other members. HEAD writes nothing either, so HEAD probes stay harmless.
 *
 * What the confirm step does *not* fix: the token is still a bearer credential with no revocation,
 * so someone holding a forwarded email can press the button themselves until it expires. Revoking
 * an issued link needs a counter on the membership, carried in the token payload and bumped
 * whenever the member changes `viewEmailMode` from the dashboard — an OrgMembership schema change,
 * not a change to this route. The confirm step is what stops a *machine* from doing it by accident.
 *
 * POST is RFC 8058 one-click unsubscribe: the email's `List-Unsubscribe` header points here and
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` makes the mail provider (Gmail, Yahoo, Apple
 * Mail) POST that body, form-encoded, with the token still in the query string. The provider shows
 * its own confirmation, so the answer is a bodyless status: 200 once the mode is `off` (idempotent),
 * 400 for a body that is not the one-click form or a token that is not valid (an expired token
 * changes nothing, as on GET), 500 on a server failure. The confirm button on the GET page posts
 * that same one-click body, so the human path and the provider path share one write; a submission
 * that arrives from a browser (it accepts HTML) gets the confirmation page instead of a blank one.
 */
import { VIEW_EMAIL_PREFERENCES_PATH } from "@/lib/notifications/viewNotifications";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { EMAIL_OFF_KINDS, verifyAnyEmailsOffToken, type EmailOffKind } from "@/lib/notifications/viewEmailToken";
import { debugError } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the notification preferences live (Dashboard -> Account -> Email preferences). */
/**
 * Where "Change how often" lands — the same constant the emails use, never a second copy.
 *
 * It moved with the settings. The old `?tab=account#email-preferences` is baked into every view
 * email already sent and cannot be changed retroactively, so that anchor still exists on the
 * Account tab as a signpost pointing here, rather than those links landing on a page with no such
 * setting on it.
 */
const PREFERENCES_PATH = VIEW_EMAIL_PREFERENCES_PATH;

/** What the confirmation page says, per kind. One route serves both; only the words differ. */
/**
 * Everything on this page that depends on which kind of email the link came from.
 *
 * The write path was made kind-aware when doc-update mail got its own token; the *rendering* path
 * was not, and kept reading `viewEmailMode` regardless. That produced two wrong pages from a
 * doc-update link: one that described view emails while its button wrote the doc-update field,
 * and — when the member happened to have view emails already off — a dead end with no button at
 * all, so the doc-update mail they were trying to stop kept arriving.
 */
const OFF_COPY: Record<
  EmailOffKind,
  {
    title: string;
    line: (workspace: string) => string;
    /** The heading on the confirmation page, before anything is written. */
    confirmTitle: string;
    /** The button, which must name the thing it will actually switch off. */
    confirmLabel: string;
    /** How the current setting reads back, per mode. */
    sentence: Record<ViewEmailMode, string>;
  }
> = {
  views: {
    title: "View emails are off",
    line: (w) => `You won't get emails when someone opens a document in ${w}.`,
    confirmTitle: "Turn off view emails",
    confirmLabel: "Turn off view emails",
    sentence: {
      off: "View emails are already off",
      daily: "View emails are set to a daily digest",
      immediate: "View emails arrive immediately",
    },
  },
  doc_updates: {
    title: "Document update emails are off",
    line: (w) => `You won't get emails when a document is replaced in ${w}.`,
    confirmTitle: "Turn off document update emails",
    confirmLabel: "Turn off document update emails",
    sentence: {
      off: "Document update emails are already off",
      daily: "Document update emails are set to a daily digest",
      immediate: "Document update emails arrive immediately",
    },
  },
};

type ViewEmailMode = "off" | "daily" | "immediate";

/** Read a stored mode; a missing or unknown value means the schema default, "daily". */
function normalizeMode(v: unknown): ViewEmailMode {
  return v === "off" || v === "immediate" ? v : "daily";
}

/** Escape untrusted text for HTML element content and attribute values. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

type PageContent = {
  /** Browser tab title (plain text; escaped here). */
  title: string;
  /** Headline (plain text; escaped here). */
  heading: string;
  /** Pre-escaped HTML lines under the headline. */
  lines: string[];
  /**
   * When set, the page shows the button that actually turns view emails off. It posts back to this
   * same URL with the RFC 8058 one-click body, so the human click and the mail provider's
   * `List-Unsubscribe-Post` land on exactly one write path (`POST`, below).
   */
  confirm?: { token: string; label: string };
};

/** Primary action look, shared by the confirm button and the preferences link when it stands alone. */
const PRIMARY_STYLE =
  "display:inline-block;padding:11px 16px;border-radius:10px;background:#fafafa;color:#0a0a0b;font-size:14px;font-weight:600;text-decoration:none;border:0;cursor:pointer;font-family:inherit;";
/** Secondary look for the preferences link once the confirm button owns the primary slot. */
const SECONDARY_STYLE =
  "display:inline-block;margin-top:14px;font-size:14px;font-weight:600;color:#a1a1aa;text-decoration:underline;";

/** Render the self-contained confirmation page (inline styles only, no external assets). */
function renderPage(content: PageContent, status: number): Response {
  const lineHtml = content.lines
    .map((l) => `<p style="margin:12px 0 0;font-size:15px;line-height:1.55;color:#a1a1aa;">${l}</p>`)
    .join("");

  // The action keeps the token in the query string, where the POST handler reads it from; the token
  // is base64url plus a dot, but escape it anyway rather than trusting that to stay true.
  const actionHtml = content.confirm
    ? `<form method="post" action="?t=${escapeHtml(encodeURIComponent(content.confirm.token))}" style="margin:22px 0 0;">` +
      `<input type="hidden" name="List-Unsubscribe" value="One-Click">` +
      `<button type="submit" style="${PRIMARY_STYLE}">${escapeHtml(content.confirm.label)}</button>` +
      `</form>` +
      `<div><a href="${PREFERENCES_PATH}" style="${SECONDARY_STYLE}">Change how often instead</a></div>`
    : `<a href="${PREFERENCES_PATH}" style="margin-top:22px;${PRIMARY_STYLE}">Change how often</a>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(content.title)} · LinkDrop</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0b;color:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
<main style="box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 20px;">
<div style="box-sizing:border-box;width:100%;max-width:440px;">
<div style="font-size:13px;font-weight:600;letter-spacing:0.02em;color:#71717a;">LinkDrop</div>
<div style="margin-top:14px;padding:24px 22px;border:1px solid #27272a;border-radius:16px;background:#131316;">
<h1 style="margin:0;font-size:21px;line-height:1.3;font-weight:600;color:#fafafa;">${escapeHtml(content.heading)}</h1>
${lineHtml}
${actionHtml}
</div>
<p style="margin:14px 2px 0;font-size:12px;line-height:1.5;color:#52525b;">Other email preferences are not affected.</p>
</div>
</main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // `form-action 'self'`, not 'none': the confirm button posts back to this same route. Nothing
      // else is allowed to load or be posted to, and the page still cannot be framed.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}

/** Neutral page for a malformed, forged or no-longer-applicable link. */
function invalidPage(): Response {
  return renderPage(
    {
      title: "Link not valid",
      heading: "This link is not valid",
      lines: [
        "It may have been copied incompletely. You can change view emails from your email preferences after signing in.",
      ],
    },
    400,
  );
}

/** Server-side failure page; nothing was changed. */
function errorPage(): Response {
  return renderPage(
    {
      title: "Something went wrong",
      heading: "Something went wrong",
      lines: ["Your email settings were not changed. Try the link again in a moment, or change them from your email preferences."],
    },
    500,
  );
}

/** Escaped workspace name for a sentence, or a neutral fallback. */
function workspaceLabel(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  return n ? `<strong style="color:#e4e4e7;font-weight:600;">${escapeHtml(n)}</strong>` : "this workspace";
}

/** Load the workspace (org) name for the membership being shown. */
async function loadWorkspaceName(orgId: unknown): Promise<unknown> {
  if (!orgId) return null;
  const org = await OrgModel.findOne({ _id: orgId }).select({ name: 1 }).lean();
  return (org as { name?: unknown } | null)?.name ?? null;
}

/** Verify the token and turn view emails off (when `write`), or report the current state. */
async function handle(request: Request, opts: { write: boolean }): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";

  let verified: ReturnType<typeof verifyAnyEmailsOffToken>;
  try {
    verified = verifyAnyEmailsOffToken(token);
  } catch (e) {
    // Only a missing signing secret in production throws; that is a server problem, not a bad link.
    debugError(1, "[notifications/views/off] token verification failed", e);
    return errorPage();
  }

  const membershipId = verified.ok ? verified.membershipId : verified.reason === "expired" ? verified.membershipId : undefined;
  if (!membershipId || !Types.ObjectId.isValid(membershipId)) return invalidPage();
  const _id = new Types.ObjectId(membershipId);
  const notDeleted = { _id, isDeleted: { $ne: true } };

  try {
    await connectMongo();

    if (verified.ok && opts.write) {
      // The field comes off the token, never off the URL: a `?kind=` parameter is editable by
      // whoever holds the link, which would let an unsubscribe link for one kind of mail switch
      // off another.
      const membership = await OrgMembershipModel.findOneAndUpdate(
        notDeleted,
        { $set: { [EMAIL_OFF_KINDS[verified.kind].field]: "off" } },
        { new: true, runValidators: true },
      )
        .select({ orgId: 1 })
        .lean();
      // Membership removed since the email went out: nothing to turn off, and nothing to reveal.
      if (!membership) return invalidPage();
      const name = await loadWorkspaceName((membership as { orgId?: unknown }).orgId);
      const done = OFF_COPY[verified.kind];
      return renderPage(
        {
          title: done.title,
          heading: done.title,
          lines: [done.line(workspaceLabel(name)), "Turned this off by mistake? Change how often below."],
        },
        200,
      );
    }

    // Read-only pass: a GET, or a HEAD probe, or an expired-but-signed link. Report the current
    // state and change nothing.
    /**
     * Which preference this link is about.
     *
     * An expired-but-signed link still verifies far enough to name its kind, so the page can
     * describe the right setting even when it can no longer change it. Only a token so malformed
     * that no kind could be read falls back, and `views` is the safe fallback because it is the
     * only kind whose links predate the others.
     */
    // The failure arm carries the kind too now. An expired doc-update link used to fall back to
    // "views", so the page read `viewEmailMode` and told somebody the state of a setting their
    // link was not about — "View emails are off" on a link they opened about document updates.
    const kind: EmailOffKind = verified.ok ? verified.kind : (verified.kind ?? "views");
    const copy = OFF_COPY[kind];
    const field = EMAIL_OFF_KINDS[kind].field;

    const membership = await OrgMembershipModel.findOne(notDeleted).select({ orgId: 1, [field]: 1 }).lean();
    if (!membership) return invalidPage();
    const mode = normalizeMode((membership as Record<string, unknown>)[field]);
    const name = await loadWorkspaceName((membership as { orgId?: unknown }).orgId);
    const stateLine = `${escapeHtml(copy.sentence[mode])} for ${workspaceLabel(name)}.`;

    if (verified.ok) {
      // A live link opened in a browser: ask. This is the branch that used to write on sight, which
      // is why a link scanner fetching the footer URL could turn a member's notifications off.
      if (mode === "off") {
        return renderPage(
          { title: copy.title, heading: copy.title, lines: [copy.line(workspaceLabel(name))] },
          200,
        );
      }
      return renderPage(
        {
          title: copy.confirmTitle,
          heading: "Turn off these emails?",
          lines: [
            stateLine,
            kind === "views"
              ? "Confirm below and you'll stop hearing when someone opens a document there."
              : "Confirm below and you'll stop hearing when a document is replaced there.",
          ],
          // The button must name what it will actually switch off; it used to say "view emails"
          // while the POST behind it wrote the doc-update setting.
          confirm: { token, label: copy.confirmLabel },
        },
        200,
      );
    }

    return renderPage(
      {
        title: mode === "off" ? "View emails are off" : "Link expired",
        heading: mode === "off" ? "View emails are off" : "This link has expired",
        lines: [
          stateLine,
          mode === "off"
            ? "This link has expired, but there is nothing to change."
            : "Nothing was changed. You can turn them off from your email preferences.",
        ],
      },
      200,
    );
  } catch (e) {
    debugError(1, "[notifications/views/off] failed", e);
    return errorPage();
  }
}

/**
 * The link from the email body. Read-only on purpose: see the note at the top of this file — the
 * URL sits in the visible footer of every view email, so anything that merely fetches links in mail
 * would otherwise turn a member's notifications off for them. The page it renders carries the
 * confirm button, and that button's POST is the only thing that writes.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(request, { write: false });
}

/**
 * Did this POST come from a person in a browser rather than a mail provider's one-click machinery?
 * Providers show their own confirmation and want a bodyless status; a browser has navigated here and
 * needs a page to land on, so answer it with the same HTML `handle` renders.
 */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/** Bodyless answer for the one-click POST; the mail provider shows its own confirmation. */
function oneClickStatus(status: number): Response {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store, max-age=0", "x-robots-tag": "noindex, nofollow" },
  });
}

/** Whether a POST body is RFC 8058's `List-Unsubscribe=One-Click` (form-encoded or multipart). */
async function isOneClickBody(request: Request): Promise<boolean> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      return form.get("List-Unsubscribe") === "One-Click";
    }
    const raw = (await request.text()).slice(0, 2048);
    return new URLSearchParams(raw.trim()).get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

/** RFC 8058 one-click unsubscribe (`List-Unsubscribe-Post`) posts to the same URL. */
export async function POST(request: Request): Promise<Response> {
  // Read the body first either way: it is a one-shot stream, and `handle` below never touches it.
  const oneClick = await isOneClickBody(request);
  const fromBrowser = wantsHtml(request);
  if (!oneClick) return fromBrowser ? invalidPage() : oneClickStatus(400);

  // The confirm button on the GET page: same write, but the person gets a page back rather than a
  // blank tab. `handle` re-verifies the token itself, so nothing is trusted from the form.
  if (fromBrowser) return handle(request, { write: true });

  const token = new URL(request.url).searchParams.get("t") ?? "";
  let verified: ReturnType<typeof verifyAnyEmailsOffToken>;
  try {
    verified = verifyAnyEmailsOffToken(token);
  } catch (e) {
    debugError(1, "[notifications/views/off] token verification failed", e);
    return oneClickStatus(500);
  }
  if (!verified.ok || !Types.ObjectId.isValid(verified.membershipId)) return oneClickStatus(400);

  try {
    await connectMongo();
    const res = await OrgMembershipModel.updateOne(
      { _id: new Types.ObjectId(verified.membershipId), isDeleted: { $ne: true } },
      { $set: { [EMAIL_OFF_KINDS[verified.kind].field]: "off" } },
      { runValidators: true },
    );
    // Membership removed since the email went out: nothing to turn off.
    if (!res.matchedCount) return oneClickStatus(400);
    return oneClickStatus(200);
  } catch (e) {
    debugError(1, "[notifications/views/off] one-click failed", e);
    return oneClickStatus(500);
  }
}

/** Link scanners and previewers often probe with HEAD; answer with GET's status and no body. */
export async function HEAD(request: Request): Promise<Response> {
  const res = await handle(request, { write: false });
  return new Response(null, { status: res.status, headers: res.headers });
}
