import { redactLogText } from "@/lib/errors/logger";

type SendTextEmailParams = {
  to: string;
  subject: string;
  text: string;
  /**
   * Optional HTML body. When present it is sent alongside `text` (the text part stays the
   * fallback for clients that do not render HTML). Callers are responsible for escaping any
   * user content they put in it.
   */
  html?: string;
  /**
   * Optional override for From.
   * If omitted, uses `NOTIFICATION_EMAIL_FROM` or falls back to `INVITE_EMAIL_FROM`.
   */
  from?: string | null;
  /**
   * Optional extra mail headers, passed to Resend as `headers` (omitted when absent or empty).
   * Used for RFC 8058 one-click unsubscribe (`List-Unsubscribe`, `List-Unsubscribe-Post`).
   * Entries whose name is not a plain header token, or whose value has a line break, are dropped.
   */
  headers?: Record<string, string>;
};

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** Only well-formed headers survive; a line break in a value could inject another header. */
function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name) || typeof value !== "string" || !value || /[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Email helper: send a plain text email, optionally with an HTML alternative.
 *
 * Supports a safe local/dev mode:
 * - `EMAIL_TRANSPORT=console` will log the payload instead of sending (no API keys needed).
 *
 * Production sending uses Resend's HTTP API (`RESEND_API_KEY`).
 */
/**
 * The name a recipient sees in their inbox list, when the configured From is a bare address.
 *
 * `INVITE_EMAIL_FROM` is `hi@updates.lnkdrp.com`, and a bare address has no display name — so every
 * client fell back to showing the local part, and our mail arrived from a sender called **hi**.
 *
 * Fixed here rather than only in the environment variable because there are three of them across
 * two deployments plus every developer's `.env.local`, and a bare address in any one of them brings
 * "hi" back. A value that already carries a display name is left exactly as configured.
 */
const FROM_NAME = (process.env.EMAIL_FROM_NAME ?? "").trim() || "LinkDrop Team";

/** RFC 5322: a display name with anything but letters, digits and spaces has to be quoted. */
function withDisplayName(from: string): string {
  const value = from.trim();
  // Already `Name <addr>` — including a quoted name, which can itself contain angle brackets.
  if (value.includes("<")) return value;
  // Not an address we recognise; pass it through rather than build something malformed.
  if (!value.includes("@") || /[,;]/.test(value)) return value;
  const name = /^[A-Za-z0-9 ]+$/.test(FROM_NAME) ? FROM_NAME : `"${FROM_NAME.replace(/["\\]/g, "\\$&")}"`;
  return `${name} <${value}>`;
}

export async function sendTextEmail(params: SendTextEmailParams): Promise<void> {
  const { to, subject, text } = params;
  const html = typeof params.html === "string" && params.html.length > 0 ? params.html : undefined;
  const headers = cleanHeaders(params.headers);

  const transport = (process.env.EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  if (transport === "console") {
    // Dev review path: print both bodies in full, unescaped strings, so copy can be read as sent.
    // eslint-disable-next-line no-console
    console.log("[email:console]", { to, subject, ...(headers ? { headers } : {}) });
    // eslint-disable-next-line no-console
    console.log(`[email:console] text:\n${text}`);
    if (html) {
      // eslint-disable-next-line no-console
      console.log(`[email:console] html:\n${html}`);
    }
    return;
  }

  let apiKey: string;
  let from: string;
  try {
    apiKey = mustGetEnv("RESEND_API_KEY");
    from = withDisplayName(
      (params.from ?? null)?.trim() ||
        (process.env.NOTIFICATION_EMAIL_FROM ?? "").trim() ||
        (process.env.INVITE_EMAIL_FROM ?? "").trim() ||
        mustGetEnv("INVITE_EMAIL_FROM"),
    );
  } catch (err) {
    logSendFailure({ subject, code: "config", detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(headers ? { headers } : {}),
      }),
    });
  } catch (err) {
    logSendFailure({ subject, code: err instanceof Error ? err.name : "fetch_failed" });
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logSendFailure({ subject, status: res.status, code: resendErrorName(body) });
    throw new Error(`Failed to send email (${res.status}): ${body || res.statusText}`);
  }
}

/**
 * One console line per failed send, whatever DEBUG_LEVEL is, so failures show in Vercel Logs.
 * Never the recipient, body or provider message (Resend echoes the address back in validation errors).
 */
function logSendFailure(args: { subject: string; status?: number; code?: string; detail?: string }): void {
  // eslint-disable-next-line no-console
  console.error("[email] send failed", {
    transport: "resend",
    ...(args.status != null ? { status: args.status } : {}),
    code: args.code ?? "unknown",
    kind: subjectKind(args.subject),
    ...(args.detail ? { detail: redactLogText(args.detail, 120) } : {}),
  });
}

/** Resend error bodies are `{ statusCode, name, message }`; `name` is a stable code like `validation_error`. */
function resendErrorName(body: string): string {
  try {
    const name = (JSON.parse(body) as { name?: unknown })?.name;
    if (typeof name === "string" && /^[a-z0-9_]{1,60}$/i.test(name)) return name;
  } catch {
    // not JSON
  }
  return "http_error";
}

/**
 * The template-ish part of a subject: the prefix before `:` ("Download request", "Daily digest"),
 * with quoted names and numbers stripped, so doc titles and people never reach the log.
 */
function subjectKind(subject: string): string {
  const s = String(subject ?? "");
  const prefix = s.includes(":") ? s.slice(0, s.indexOf(":")) : s;
  return redactLogText(prefix.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "#"), 60);
}

/** Return an environment variable or throw with a clear configuration error. */
function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Send a built template, whole.
 *
 * `sendTextEmail` takes loose fields, and every caller reached it the same way:
 * `const { subject, text } = someEmail(...)`. That was correct while templates were text-only and
 * became a silent bug the day they grew an HTML part — eight senders kept destructuring two fields
 * out of three, so the mail still went, still read fine, and simply arrived as plain text. Nothing
 * failed and no test noticed.
 *
 * Passing the whole `EmailContent` through makes that impossible: a part added to a template
 * reaches the transport without anyone remembering to widen a destructure.
 */
export async function sendEmailContent(
  params: { to: string; from?: string | null } & EmailContentLike,
): Promise<void> {
  await sendTextEmail({
    to: params.to,
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.from ? { from: params.from } : {}),
  });
}

/** Structural, not imported: keeps this module free of a dependency on the template layer. */
type EmailContentLike = {
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};
