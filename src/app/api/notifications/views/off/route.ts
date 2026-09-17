/**
 * API route: GET / POST `/api/notifications/views/off?t=<token>`
 *
 * One-click "Turn off these emails" from a view notification email
 * (docs/prds/lnkdrp-view-notifications.md, decision 8). No sign-in: the signed token
 * (`@/lib/notifications/viewEmailToken`) is the authority, because the email is usually
 * opened on a phone where the member is not signed in.
 *
 * - Valid token: set that membership's `viewEmailMode` to `off` and confirm. Idempotent.
 * - Expired but correctly signed: change nothing, show the current state and the preferences link.
 * - Malformed / bad signature / wrong purpose: a neutral "not valid" page, status 400.
 *
 * The page only ever shows the token's own membership (its workspace name and mode), nothing
 * about other members. HEAD never writes, so link scanners that probe with HEAD are harmless.
 *
 * POST is RFC 8058 one-click unsubscribe: the email's `List-Unsubscribe` header points here and
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` makes the mail provider (Gmail, Yahoo, Apple
 * Mail) POST that body, form-encoded, with the token still in the query string. The provider shows
 * its own confirmation, so the answer is a bodyless status: 200 once the mode is `off` (idempotent),
 * 400 for a body that is not the one-click form or a token that is not valid (an expired token
 * changes nothing, as on GET), 500 on a server failure.
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { verifyViewEmailsOffToken } from "@/lib/notifications/viewEmailToken";
import { debugError } from "@/lib/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the notification preferences live (Dashboard -> Account -> Email preferences). */
const PREFERENCES_PATH = "/dashboard?tab=account#email-preferences";

type ViewEmailMode = "off" | "daily" | "immediate";

/** Read a stored mode; a missing or unknown value means the schema default, "daily". */
function normalizeMode(v: unknown): ViewEmailMode {
  return v === "off" || v === "immediate" ? v : "daily";
}

const MODE_SENTENCE: Record<ViewEmailMode, string> = {
  off: "View emails are off",
  daily: "View emails are set to a daily digest",
  immediate: "View emails are set to arrive as views happen",
};

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
};

/** Render the self-contained confirmation page (inline styles only, no external assets). */
function renderPage(content: PageContent, status: number): Response {
  const lineHtml = content.lines
    .map((l) => `<p style="margin:12px 0 0;font-size:15px;line-height:1.55;color:#a1a1aa;">${l}</p>`)
    .join("");

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
<a href="${PREFERENCES_PATH}" style="display:inline-block;margin-top:22px;padding:11px 16px;border-radius:10px;background:#fafafa;color:#0a0a0b;font-size:14px;font-weight:600;text-decoration:none;">Change how often</a>
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
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

  let verified: ReturnType<typeof verifyViewEmailsOffToken>;
  try {
    verified = verifyViewEmailsOffToken(token);
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
      const membership = await OrgMembershipModel.findOneAndUpdate(
        notDeleted,
        { $set: { viewEmailMode: "off" } },
        { new: true, runValidators: true },
      )
        .select({ orgId: 1 })
        .lean();
      // Membership removed since the email went out: nothing to turn off, and nothing to reveal.
      if (!membership) return invalidPage();
      const name = await loadWorkspaceName((membership as { orgId?: unknown }).orgId);
      return renderPage(
        {
          title: "View emails are off",
          heading: "View emails are off",
          lines: [
            `You won't get emails when someone opens a document in ${workspaceLabel(name)}.`,
            "Turned this off by mistake? Change how often below.",
          ],
        },
        200,
      );
    }

    // Expired (or a HEAD probe): report the current state without changing it.
    const membership = await OrgMembershipModel.findOne(notDeleted).select({ orgId: 1, viewEmailMode: 1 }).lean();
    if (!membership) return invalidPage();
    const mode = normalizeMode((membership as { viewEmailMode?: unknown }).viewEmailMode);
    const name = await loadWorkspaceName((membership as { orgId?: unknown }).orgId);
    const lines = [`${escapeHtml(MODE_SENTENCE[mode])} for ${workspaceLabel(name)}.`];
    if (!verified.ok) {
      lines.push(
        mode === "off"
          ? "This link has expired, but there is nothing to change."
          : "Nothing was changed. You can turn them off from your email preferences.",
      );
    }
    return renderPage(
      {
        title: mode === "off" ? "View emails are off" : "Link expired",
        heading: mode === "off" ? "View emails are off" : verified.ok ? MODE_SENTENCE[mode] : "This link has expired",
        lines,
      },
      200,
    );
  } catch (e) {
    debugError(1, "[notifications/views/off] failed", e);
    return errorPage();
  }
}

/** One-click off from the email link. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, { write: true });
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
  if (!(await isOneClickBody(request))) return oneClickStatus(400);

  const token = new URL(request.url).searchParams.get("t") ?? "";
  let verified: ReturnType<typeof verifyViewEmailsOffToken>;
  try {
    verified = verifyViewEmailsOffToken(token);
  } catch (e) {
    debugError(1, "[notifications/views/off] token verification failed", e);
    return oneClickStatus(500);
  }
  if (!verified.ok || !Types.ObjectId.isValid(verified.membershipId)) return oneClickStatus(400);

  try {
    await connectMongo();
    const res = await OrgMembershipModel.updateOne(
      { _id: new Types.ObjectId(verified.membershipId), isDeleted: { $ne: true } },
      { $set: { viewEmailMode: "off" } },
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

/** Link scanners and previewers often probe with HEAD; answer without writing. */
export async function HEAD(request: Request): Promise<Response> {
  const res = await handle(request, { write: false });
  return new Response(null, { status: res.status, headers: res.headers });
}
