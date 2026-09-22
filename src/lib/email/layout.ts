/**
 * One HTML shell and one block vocabulary for every email lnkdrp sends.
 *
 * This is lifted almost unchanged out of `notifications/viewNotifications.ts`, which had grown a
 * properly hardened email renderer — bulletproof buttons, an Outlook-only fixed-width table, a
 * hidden preheader, `color-scheme: light only` so dark-mode clients cannot invert the card, and
 * `word-break` so a 120-character filename does not stretch it. All of that was reachable only by
 * the share-view notifications; every other template was plain text. Rather than write a second,
 * worse shell for the others, the good one moved here.
 *
 * **Blocks render to both bodies.** A template describes what it wants to say — a heading, a
 * paragraph, a button — and never writes markup. `renderText` and `renderHtml` walk the same array,
 * so the text part cannot drift from the HTML part or quietly lose a link, which is the usual way
 * multipart mail rots. It also means escaping is not a thing a template author can forget.
 *
 * Inline styles and tables, deliberately: Gmail strips `<style>` blocks, Outlook ignores
 * `max-width`, and neither has a flexbox worth the name. This is what survives.
 */

/** The system stack; no webfont, because a webfont in mail is a download that usually fails. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Long unbroken user strings (a 120-character title with no spaces) wrap instead of widening the card. */
const BREAK = "word-break:break-word;overflow-wrap:anywhere;";

/** Pads the hidden preheader so the client does not pull body text into the inbox preview. */
const PREHEADER_FILLER = "&#847;&zwnj;&nbsp;".repeat(40);

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The mark in the header, as an absolute URL to a PNG.
 *
 * PNG because Gmail does not render SVG in mail, and `public/icon-black.svg` is the only logo the
 * app otherwise has; `public/email-logo.png` is that file rasterised at 4x its display size.
 *
 * It is served from blob storage rather than from this app's own `/public`, and that is the point.
 * A page resolves a relative path against whatever host served it; an email is opened in somebody
 * else's mail client, where the only thing that works is an absolute URL to something already
 * public. A `/public` asset only starts resolving on the next deploy — so every email sent between
 * adding the file and shipping it carries a broken-image box, which is exactly what happened.
 * Blob is live the moment `scripts/publish-email-logo.ts` runs, and stays live across deploys and
 * rollbacks.
 *
 * `public/email-logo.png` remains in the repo as the source of truth for what was uploaded.
 * `EMAIL_LOGO_URL` overrides this for a deployment with its own branding.
 */
const LOGO_URL =
  (process.env.EMAIL_LOGO_URL ?? "").trim() ||
  "https://svmsosyeuyawzaqr.public.blob.vercel-storage.com/brand/email-logo.png";

/**
 * Which workspace an email is about.
 *
 * Owner-facing mail needs this and did not have it: "2 people opened Series A deck" is ambiguous
 * the moment somebody belongs to two workspaces, and a workspace can be an entirely different
 * company. Reader-facing mail needs it for the opposite reason — the reader has no idea who
 * LinkDrop is, and the thing they recognise is the sender's own name and mark.
 */
export type EmailWorkspace = {
  name: string;
  /** `Org.avatarUrl`; when absent an initials disc is drawn instead, so there is always a mark. */
  avatarUrl?: string | null;
};

/** The two-letter disc used when a workspace has no avatar, matching the app's initials avatar. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A workspace's mark: its avatar, or an initials disc drawn in a table cell.
 *
 * Initials are a `<td>` with a background rather than an `<img>`, because it needs no hosting and
 * cannot be blocked — the case where a workspace has no avatar is exactly the case where a broken
 * image would be worst.
 */
function workspaceMark(ws: EmailWorkspace): string {
  const url = (ws.avatarUrl ?? "").trim();
  if (url) {
    return (
      `<img src="${escapeHtml(url)}" width="20" height="20" alt="" ` +
      `style="display:block;width:20px;height:20px;border-radius:4px;border:0;outline:none;object-fit:cover;" />`
    );
  }
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
    `<td width="20" height="20" align="center" bgcolor="#e4e4e7" ` +
    `style="width:20px;height:20px;border-radius:4px;background:#e4e4e7;font-family:${FONT};font-size:9px;` +
    `line-height:20px;font-weight:700;letter-spacing:0.02em;color:#52525b;">${escapeHtml(initialsOf(ws.name))}</td>` +
    `</tr></table>`
  );
}

/**
 * Header: our mark on the left, the workspace on the right.
 *
 * The wordmark stays as text on purpose. Most clients block remote images until the reader allows
 * them, so a header that is only an image is a blank space on first open — for a welcome email,
 * the first thing a new account ever sees from us. The `alt` is empty because the name is already
 * sitting next to it; giving the image the same alt text prints "LinkDrop LinkDrop" when blocked.
 *
 * The workspace sits opposite rather than underneath so it reads as provenance — who this is
 * about — instead of as a subtitle to our own name.
 */
function header(workspace?: EmailWorkspace | null): string {
  /** Our mark and name, as one shrink-to-fit unit. */
  const ours =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
    `<td style="padding:0 8px 0 0;vertical-align:middle;line-height:0;">` +
    `<img src="${escapeHtml(LOGO_URL)}" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0;outline:none;text-decoration:none;" />` +
    `</td>` +
    `<td style="vertical-align:middle;font-family:${FONT};font-size:13px;line-height:1.4;font-weight:600;letter-spacing:0.02em;color:#71717a;white-space:nowrap;">LinkDrop</td>` +
    `</tr></table>`;

  if (!workspace || !workspace.name.trim()) return ours;

  /**
   * Long names are cut rather than wrapped.
   *
   * The first version let the name wrap, and a squeezed right-hand cell broke "Acme" into four
   * stacked letters. A header is one line by definition; a name too long for it is a name to
   * shorten, not a reason to grow the header.
   */
  const name = workspace.name.trim();
  const shown = name.length > 28 ? `${name.slice(0, 27).trimEnd()}\u2026` : name;

  /**
   * The workspace rides in its own nested table inside a single right-aligned cell.
   *
   * Two sibling cells with a percentage spacer between them is what caused the wrapping: the
   * spacer claimed the width and the text cell got whatever was left. One cell that shrinks to
   * its content, with `nowrap` on the text, cannot be squeezed by anything beside it.
   */
  const theirs =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
    `<td style="vertical-align:middle;line-height:0;padding:0 6px 0 0;">${workspaceMark(workspace)}</td>` +
    `<td style="vertical-align:middle;font-family:${FONT};font-size:13px;line-height:1.4;font-weight:600;color:#3f3f46;white-space:nowrap;">${escapeHtml(shown)}</td>` +
    `</tr></table>`;

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>` +
    `<td align="left" style="vertical-align:middle;">${ours}</td>` +
    `<td align="right" style="vertical-align:middle;">${theirs}</td>` +
    `</tr></table>`
  );
}

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "p"; text: string }
  | { kind: "muted"; text: string }
  | { kind: "rows"; rows: Array<[string, string]> }
  /** `compact`: one line of a list of viewers (tighter spacing, body size). */
  | { kind: "subheading"; text: string; compact?: boolean }
  | { kind: "bullets"; items: string[] }
  /**
   * A list of named links — a digest of several documents, where one button will not do.
   *
   * The alternative was a `rows` block with the URL as its value, which prints the raw address and
   * wraps a 70-character link across three lines. A name people recognise, carrying the link, is
   * both shorter and easier to aim at.
   */
  | { kind: "links"; items: Array<{ label: string; url: string }> }
  /**
   * `secondary`: an outlined button, for the action you would rather they did not take by reflex.
   * Approve and Deny were both solid black, identical in weight, one of them irreversible.
   */
  | { kind: "action"; label: string; url: string; variant?: "primary" | "secondary" }
  | { kind: "divider" };

/**
 * What goes under the rule at the bottom.
 *
 * Two shapes, because two kinds of mail. Notifications owe the reader a reason and a way out, and
 * `links` carries the unsubscribe. Transactional mail — a welcome, a download approval — has no
 * "off" to offer, and a footer that implies otherwise is worse than none, so it gets `signature`
 * and nothing more.
 */
export type EmailFooter = {
  /** The sign-off for transactional mail, e.g. "- LinkDrop". */
  signature?: string | null;
  /** One sentence saying why this arrived. */
  reason?: string | null;
  /** Footer links, rendered "Label · Label". */
  links?: ReadonlyArray<{ label: string; url: string }>;
};

function hasNotice(footer: EmailFooter | null | undefined): boolean {
  return Boolean(footer && (footer.reason || (footer.links && footer.links.length)));
}

export function renderText(
  blocks: readonly Block[],
  footer?: EmailFooter | null,
  workspace?: EmailWorkspace | null,
): string {
  const out: string[] = [];
  /**
   * Named rather than just printed, because a bare "Acme" on the first line of a plain-text email
   * is not self-explanatory. The HTML shows it beside a mark in a header, which carries its own
   * meaning; text has no such affordance and has to say what the word is.
   */
  if (workspace?.name.trim()) out.push(`Workspace: ${workspace.name.trim()}`, "");
  let afterCompact = false;
  for (const b of blocks) {
    const compact = b.kind === "subheading" && Boolean(b.compact);
    // A list of compact subheadings has no blank lines inside; give it one after its last line.
    if (afterCompact && !compact) out.push("");
    afterCompact = compact;
    switch (b.kind) {
      case "heading":
      case "p":
      case "muted":
        out.push(b.text, "");
        break;
      case "subheading":
        out.push(b.text);
        break;
      case "rows":
        for (const [k, v] of b.rows) out.push(k ? `${k}: ${v}` : v);
        out.push("");
        break;
      case "bullets":
        for (const item of b.items) out.push(`- ${item}`);
        out.push("");
        break;
      case "links":
        // The text part has no anchors, so the address has to be visible here or it is lost.
        for (const item of b.items) out.push(`${item.label}: ${item.url}`);
        out.push("");
        break;
      case "action":
        out.push(`${b.label}: ${b.url}`, "");
        break;
      case "divider":
        break;
    }
  }
  if (afterCompact) out.push("");

  if (hasNotice(footer)) {
    out.push("--");
    if (footer?.reason) out.push(footer.reason);
    for (const l of footer?.links ?? []) out.push(`${l.label}: ${l.url}`);
  } else if (footer?.signature) {
    out.push(footer.signature);
  }
  return out.join("\n");
}

export function renderHtml(params: {
  subject: string;
  preheader?: string;
  blocks: readonly Block[];
  footer?: EmailFooter | null;
  /** Shown top-right, so an owner in several workspaces can tell which one this is about. */
  workspace?: EmailWorkspace | null;
}): string {
  const { subject, preheader = "", blocks, footer, workspace } = params;
  const parts: string[] = [];
  // Text blocks that follow a compact list get their own top spacing back.
  let afterCompact = false;
  for (const b of blocks) {
    const gap = afterCompact && !(b.kind === "subheading" && b.compact) ? "margin-top:14px;" : "";
    switch (b.kind) {
      case "heading":
        parts.push(`<h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:1.35;font-weight:600;color:#18181b;${BREAK}">${escapeHtml(b.text)}</h1>`);
        break;
      case "subheading":
        parts.push(
          b.compact
            ? `<p style="margin:0 0 6px;font-family:${FONT};font-size:14px;line-height:1.5;font-weight:600;color:#18181b;${BREAK}">${escapeHtml(b.text)}</p>`
            : `<h2 style="margin:20px 0 8px;font-family:${FONT};font-size:15px;line-height:1.4;font-weight:600;color:#18181b;${BREAK}">${escapeHtml(b.text)}</h2>`,
        );
        break;
      case "p":
        parts.push(`<p style="margin:0 0 14px;${gap}font-family:${FONT};font-size:14px;line-height:1.55;color:#27272a;${BREAK}">${escapeHtml(b.text)}</p>`);
        break;
      case "muted":
        parts.push(`<p style="margin:0 0 14px;${gap}font-family:${FONT};font-size:13px;line-height:1.55;color:#71717a;${BREAK}">${escapeHtml(b.text)}</p>`);
        break;
      case "rows":
        if (!b.rows.length) break;
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;border-collapse:collapse;">${b.rows
            .map(([k, v]) =>
              k
                ? `<tr><td style="padding:2px 12px 2px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:#71717a;vertical-align:top;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:2px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#18181b;vertical-align:top;${BREAK}">${escapeHtml(v)}</td></tr>`
                : `<tr><td colspan="2" style="padding:2px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:#18181b;${BREAK}">${escapeHtml(v)}</td></tr>`,
            )
            .join("")}</table>`,
        );
        break;
      case "links":
        if (!b.items.length) break;
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;${gap}border-collapse:collapse;">${b.items
            .map(
              (i) =>
                `<tr><td style="padding:3px 0;font-family:${FONT};font-size:14px;line-height:1.5;${BREAK}">` +
                `<a href="${escapeHtml(i.url)}" style="color:#18181b;font-weight:600;text-decoration:underline;">${escapeHtml(i.label)}</a>` +
                `</td></tr>`,
            )
            .join("")}</table>`,
        );
        break;
      case "bullets":
        parts.push(
          `<ul style="margin:0 0 14px;padding-left:18px;">${b.items
            .map((i) => `<li style="margin:0 0 4px;font-family:${FONT};font-size:14px;line-height:1.5;color:#27272a;${BREAK}">${escapeHtml(i)}</li>`)
            .join("")}</ul>`,
        );
        break;
      case "action": {
        // Bulletproof button: Outlook ignores padding and background on <a>, so both sit on the cell.
        // `bgcolor` is there for the clients that still ignore the style attribute on a <td>.
        const secondary = b.variant === "secondary";
        const bg = secondary ? "#ffffff" : "#18181b";
        const fg = secondary ? "#3f3f46" : "#ffffff";
        const border = secondary ? "border:1px solid #d4d4d8;" : "";
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;${gap}border-collapse:separate;">` +
            `<tr><td align="center" bgcolor="${bg}" style="background:${bg};${border}border-radius:8px;padding:10px 16px;">` +
            `<a href="${escapeHtml(b.url)}" style="display:inline-block;font-family:${FONT};font-size:14px;line-height:1.3;font-weight:600;color:${fg};text-decoration:none;">${escapeHtml(b.label)}${secondary ? "" : " &rarr;"}</a>` +
            `</td></tr></table>`,
        );
        break;
      }
      case "divider":
        parts.push(`<hr style="margin:18px 0;border:0;border-top:1px solid #e4e4e7;" />`);
        break;
    }
    afterCompact = b.kind === "subheading" && Boolean(b.compact);
  }

  const footerLink = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:4px 0;color:#52525b;font-weight:600;text-decoration:underline;">${escapeHtml(label)}</a>`;

  let footerHtml = "";
  if (hasNotice(footer)) {
    const linkRow = (footer?.links ?? []).map((l) => footerLink(l.url, l.label)).join(" &nbsp;&middot;&nbsp; ");
    footerHtml =
      (footer?.reason
        ? `<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.55;color:#71717a;">${escapeHtml(footer.reason)}</p>`
        : "") +
      (linkRow ? `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.55;color:#71717a;">${linkRow}</p>` : "");
  } else if (footer?.signature) {
    footerHtml = `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.55;color:#71717a;">${escapeHtml(footer.signature)}</p>`;
  }

  const preheaderHtml = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#f4f4f5;">${escapeHtml(preheader)}${PREHEADER_FILLER}</div>`
    : "";

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f4f5;">` +
    preheaderHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">` +
    // Outlook desktop ignores max-width; a fixed-width table only it can see holds the card at 560px.
    `<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;font-family:${FONT};">` +
    `<tr><td style="padding:22px 28px 0;">${header(workspace)}</td></tr>` +
    `<tr><td style="padding:14px 28px 8px;">${parts.join("")}</td></tr>` +
    (footerHtml ? `<tr><td style="padding:16px 28px 22px;border-top:1px solid #f0f0f2;">${footerHtml}</td></tr>` : "") +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`
  );
}
