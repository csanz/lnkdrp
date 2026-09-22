/**
 * Recipients that must never be handed to the mail provider.
 *
 * Four messages to seeded `@*.example` addresses were accepted by Resend and hard-bounced, and they
 * landed against `updates.lnkdrp.com` on the day its DMARC record went up. Nothing was wrong with
 * the mail: the addresses cannot receive it. `.example` is reserved by RFC 2606 precisely so that it
 * never resolves, which makes every send to one a guaranteed bounce, and a bounce rate is the number
 * a sending domain is judged by. A developer running the notification cron against a seeded database
 * should not be able to spend the production domain's reputation.
 *
 * The backlog proposed moving the seeds to "a domain we control with no MX". That does not actually
 * fix it — a domain with no MX hard-bounces exactly like a reserved one, it just bounces somewhere we
 * own — so the rule lives here instead, at the one place every email passes through. Not sending is
 * the only thing that does not bounce.
 *
 * This is a refusal, not a failure. A reserved address is a thing nobody ever meant to email, so the
 * caller is told the send is done rather than given an error to retry: a queue row that retried a
 * `.test` recipient forever would be a worse bug than the one this closes.
 *
 * `EMAIL_BLOCKED_RECIPIENT_DOMAINS` extends it for anything a deployment knows is a sink — a seed
 * domain, a load-test domain — without another release.
 */

/**
 * Reserved for documentation and testing, and guaranteed never to resolve.
 *
 * RFC 2606 §2 (`.test`, `.example`, `.invalid`, `.localhost`) and RFC 6761, which gives the same four
 * their special-use registrations. None of them can hold an MX record, so none of them can receive.
 */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);

/** RFC 2606 §3: the three second-level names reserved alongside the TLDs above. */
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

/**
 * The domain part of an address, lowercased, or null when there isn't one.
 *
 * Deliberately forgiving about the shape around it (a display name, angle brackets, a trailing root
 * dot) because this runs to decide whether to *refuse*, and an address too malformed to parse is one
 * more reason to refuse rather than a reason to pass it along.
 */
export function recipientDomain(to: string): string | null {
  const value = String(to ?? "").trim();
  const inner = value.includes("<") ? (value.slice(value.lastIndexOf("<") + 1).split(">")[0] ?? "") : value;
  const at = inner.lastIndexOf("@");
  if (at === -1) return null;
  const domain = inner
    .slice(at + 1)
    .trim()
    .replace(/\.+$/, "")
    .toLowerCase();
  return domain || null;
}

/** Domains a deployment has declared undeliverable, from `EMAIL_BLOCKED_RECIPIENT_DOMAINS`. */
function configuredBlocklist(): Set<string> {
  const raw = (process.env.EMAIL_BLOCKED_RECIPIENT_DOMAINS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, "").replace(/\.+$/, ""))
      .filter(Boolean),
  );
}

/**
 * Why this address must not be sent to, or `null` when it may be.
 *
 * The reason is a short fixed string, safe to log: it names the rule, never the person.
 */
export function unroutableRecipientReason(to: string): string | null {
  const domain = recipientDomain(to);
  if (!domain) return "no_domain";

  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(domain) || RESERVED_TLDS.has(tld)) return "reserved_tld";
  if (RESERVED_DOMAINS.has(domain)) return "reserved_domain";

  // A configured domain covers its subdomains: `seed.lnkdrp.com` blocks `a@x.seed.lnkdrp.com` too,
  // because anyone listing a sink domain means the whole thing.
  const blocked = configuredBlocklist();
  if (blocked.size) {
    for (const entry of blocked) {
      if (domain === entry || domain.endsWith(`.${entry}`)) return "blocked_domain";
    }
  }
  return null;
}
