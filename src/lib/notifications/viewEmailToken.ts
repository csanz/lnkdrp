/**
 * Signed one-click "turn off view emails" tokens.
 *
 * Every view notification email carries a link that lets the recipient member set their
 * `OrgMembership.viewEmailMode` to `off` without a sign-in (the email is often opened on a
 * phone where the user is not signed in; see docs/prds/lnkdrp-view-notifications.md, decision 8).
 * The link therefore carries its own authority: a token binding a membership id, a purpose and
 * an expiry, signed with HMAC-SHA256. Opening the link only shows a page; the write happens when
 * the member confirms (or when their mail provider posts RFC 8058 one-click). See the TTL note
 * below for what that authority is and is not.
 *
 * Format: `<payload>.<signature>`, both base64url.
 * - payload: JSON `{ v: 1, p: "view_emails_off", m: <membershipId>, e: <expiry epoch ms> }`
 * - signature: HMAC-SHA256 over the payload segment, keyed by a key derived from the server
 *   secret and the purpose string, so a key for another purpose can never verify these tokens.
 *   When the server secret is the shared `NEXTAUTH_SECRET`, that input is itself HKDF-derived
 *   first — see `getTokenSecrets()` for why, and for the dual-read that keeps sent links working.
 *
 * Server-only (Node crypto).
 */
import crypto from "node:crypto";

export const VIEW_EMAILS_OFF_PURPOSE = "view_emails_off";

/**
 * The kinds of recurring email a member can switch off from the email itself.
 *
 * Each has its own purpose string, so a key derived for one can never verify a token for another —
 * which is the point. Doc-update mail had no unsubscribe at all and the obvious shortcut was to
 * reuse the view token; that would have made "turn off these emails" on a doc-update email set
 * `viewEmailMode`, silently switching off a different kind of mail than the one in front of them.
 *
 * `view_emails_off` keeps its original string. It is signed into every unsubscribe link already
 * sitting in somebody's mailbox and changing it would break all of them.
 */
export const EMAIL_OFF_KINDS = {
  views: { purpose: VIEW_EMAILS_OFF_PURPOSE, field: "viewEmailMode" },
  doc_updates: { purpose: "doc_update_emails_off", field: "docUpdateEmailMode" },
} as const;

export type EmailOffKind = keyof typeof EMAIL_OFF_KINDS;

/** The route reads the kind off the token rather than a query parameter, which a bearer could edit. */
export type VerifyAnyResult =
  | { ok: true; kind: EmailOffKind; membershipId: string }
  | { ok: false; reason: ViewEmailsOffTokenFailure; membershipId?: string };

/**
 * Default token lifetime: 30 days.
 *
 * This token is a bearer credential in a URL: the payload is `{ v, p, m, e }` and nothing else, so
 * it is joined to no server state and there is no way to revoke an issued one — the expiry is the
 * only bound on a link that leaks (a forwarded email, a mail archive, a shared screenshot). It is
 * kept at 30 days deliberately: an unsubscribe link people may come back to weeks later should
 * still work, and every view email ships a fresh one anyway. What makes that acceptable is that
 * holding the token is no longer enough to act — the route (`/api/notifications/views/off`) only
 * writes on an explicit POST (a person pressing the confirm button, or a mail provider's RFC 8058
 * one-click), never on a GET. To make these revocable rather than merely short-lived, the payload
 * needs a counter kept on the membership (see the note in the route) which is bumped whenever the
 * member changes `viewEmailMode` themselves; that is an OrgMembership schema change.
 */
export const VIEW_EMAILS_OFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = 1;
/** Generous upper bound; a real token is ~150 chars. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 1024;
const MAX_MEMBERSHIP_ID_LENGTH = 128;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type ViewEmailsOffTokenFailure = "malformed" | "bad_signature" | "expired" | "wrong_purpose";

export type VerifyViewEmailsOffTokenResult =
  | { ok: true; membershipId: string }
  | { ok: false; reason: ViewEmailsOffTokenFailure; membershipId?: string };

/**
 * Purpose label for the derived secret. Changing either string rotates the signing key for every
 * deployment that has not set a distinct `LNKDRP_NOTIFICATION_TOKEN_SECRET`, i.e. invalidates live
 * unsubscribe links, so they are versioned and left alone.
 */
const TOKEN_KEY_SALT = "lnkdrp-notification-token";
const TOKEN_KEY_INFO = "notification-token-hkdf:v1";

/** Dev fallback so local envs don't crash. Public by construction; never reached in production. */
const DEV_FALLBACK_SECRET = "dev-lnkdrp-notification-token-secret";

let warnedAboutDerivedSecret = false;

function deriveTokenSecret(master: string): string {
  return Buffer.from(crypto.hkdfSync("sha256", master, TOKEN_KEY_SALT, TOKEN_KEY_INFO, 32)).toString("base64url");
}

/**
 * The secrets these tokens are signed and verified with: `current` signs, `legacy` only verifies.
 *
 * What went wrong: this module took `NEXTAUTH_SECRET` verbatim whenever
 * `LNKDRP_NOTIFICATION_TOKEN_SECRET` was unset. `NEXTAUTH_SECRET` is not a notification secret — it
 * is the fallback behind session cookies, the AES key over every share password at rest
 * (`src/lib/sharePassword.ts`), the AES key over org invite tokens, the internal upload-processing
 * HMAC and this. The damage here was smaller than in `src/lib/realtime/ticket.ts`, because
 * `signingKey()` below already ran the value through an HMAC with a purpose label before signing
 * anything, and nothing outside this process ever saw it. But the *input* to that derivation was
 * still the master secret, held in a variable named for a token module, and `getTokenSecret()` was
 * a function that handed the master secret to any future caller that asked for "the token secret".
 * This closes that: the value the module holds is already one-way separated from the master.
 *
 * Why the fix is shaped this way (the part that matters): these tokens sit in already-sent emails
 * for 30 days (`VIEW_EMAILS_OFF_TTL_MS`). Rotating the key outright would mean every unsubscribe
 * link currently in someone's mailbox answers "that link is not valid" — punishing recipients for
 * a server-side hygiene change, on the one path in this product where the recipient is asking us to
 * stop emailing them. So this degrades instead of refusing: new tokens are signed with the derived
 * secret, and verification falls back to the old raw-master secret for tokens minted before this
 * change. The fallback only exists on deployments that were using the master secret in the first
 * place — where a distinct `LNKDRP_NOTIFICATION_TOKEN_SECRET` is configured, nothing rotates and
 * `legacy` is null. It costs nothing in strength: the legacy key is the same HMAC-over-purpose
 * construction that signed those links yesterday.
 *
 * Removing the fallback: safe once every email minted before the deploy has aged past
 * `VIEW_EMAILS_OFF_TTL_MS` (30 days). Delete the `legacy` branch then; a stale link failing after
 * that point was going to fail on expiry anyway.
 *
 * Mirrors `sharePassword.getCookieSecret` in throwing rather than degrading when nothing is
 * configured in production: an unsubscribe link signed with a public key is forgeable.
 */
function getTokenSecrets(): { current: string; legacy: string | null } {
  // Not trimmed: these are used as key material and were used untrimmed before, so trimming here
  // would silently rotate the key for anyone whose configured value has stray whitespace.
  const dedicated = process.env.LNKDRP_NOTIFICATION_TOKEN_SECRET || "";
  const master = process.env.NEXTAUTH_SECRET || "";

  // A secret set for this purpose is used exactly as configured — unless it is merely a copy of the
  // master secret, which is the same mistake wearing a different variable name.
  if (dedicated.trim() && dedicated.trim() !== master.trim()) return { current: dedicated, legacy: null };

  const shared = dedicated.trim() ? dedicated : master;
  if (shared.trim()) {
    if (!warnedAboutDerivedSecret && process.env.NODE_ENV === "production") {
      warnedAboutDerivedSecret = true;
      console.warn(
        "[notifications] LNKDRP_NOTIFICATION_TOKEN_SECRET is not set (or matches NEXTAUTH_SECRET); signing notification tokens with a secret derived from NEXTAUTH_SECRET. Set a distinct LNKDRP_NOTIFICATION_TOKEN_SECRET so this key is independent of the session secret.",
      );
    }
    return { current: deriveTokenSecret(shared), legacy: shared };
  }

  if (process.env.NODE_ENV !== "production") return { current: DEV_FALLBACK_SECRET, legacy: null };

  throw new Error("Missing LNKDRP_NOTIFICATION_TOKEN_SECRET (or NEXTAUTH_SECRET) for notification tokens");
}

/** Derive the per-purpose signing key from a server secret. */
function signingKey(purpose: string, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(`lnkdrp.notification-token.v1:${purpose}`).digest();
}

/** HMAC-SHA256 of a payload segment under the purpose-bound key. */
function sign(payloadSegment: string, purpose: string, secret: string): Buffer {
  return crypto.createHmac("sha256", signingKey(purpose, secret)).update(payloadSegment).digest();
}

/** Constant-time equality that never throws: unequal lengths are simply unequal. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** A membership id is a non-empty string of bounded length with no surrounding whitespace. */
function isValidMembershipId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_MEMBERSHIP_ID_LENGTH && v.trim() === v;
}

/** Create a signed token that lets its bearer set one of this membership's email modes to `off`. */
export function createEmailsOffToken(
  kind: EmailOffKind,
  membershipId: string,
  opts?: { now?: Date; ttlMs?: number },
): string {
  const purpose = EMAIL_OFF_KINDS[kind].purpose;
  const id = String(membershipId ?? "");
  if (!isValidMembershipId(id)) throw new Error("createEmailsOffToken: invalid membershipId");
  const now = opts?.now ?? new Date();
  const ttlMs =
    typeof opts?.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : VIEW_EMAILS_OFF_TTL_MS;
  const payload = { v: TOKEN_VERSION, p: purpose, m: id, e: Math.floor(now.getTime() + ttlMs) };
  const payloadSegment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  // Minting always uses the current secret; `legacy` is a read-only concession to links already sent.
  const sig = sign(payloadSegment, purpose, getTokenSecrets().current).toString("base64url");
  return `${payloadSegment}.${sig}`;
}

/** Back-compat wrapper: the view kind by name, for callers and tests that predate the others. */
export function createViewEmailsOffToken(membershipId: string, opts?: { now?: Date; ttlMs?: number }): string {
  return createEmailsOffToken("views", membershipId, opts);
}

/**
 * Verify a view-emails-off token.
 *
 * Order: shape (malformed) -> signature (bad_signature) -> payload (malformed) -> purpose
 * (wrong_purpose) -> expiry (expired, with the membership id since the signature was valid).
 * Never throws for untrusted input; only a missing secret in production throws.
 */
function verifyForPurpose(purpose: string, token: string, opts?: { now?: Date }): VerifyViewEmailsOffTokenResult {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadSegment, sigSegment] = parts as [string, string];
  if (!BASE64URL_RE.test(payloadSegment) || !BASE64URL_RE.test(sigSegment)) {
    return { ok: false, reason: "malformed" };
  }

  const { current, legacy } = getTokenSecrets();
  const given = Buffer.from(sigSegment, "base64url");
  // Current secret first; then, only where the key rotated (see `getTokenSecrets`), the secret that
  // signed the links already sitting in people's mailboxes. Both comparisons are constant-time, and
  // the second one runs on failure only, which leaks nothing a forger did not already know.
  let matched = safeEqual(given, sign(payloadSegment, purpose, current));
  if (!matched && legacy) matched = safeEqual(given, sign(payloadSegment, purpose, legacy));
  if (!matched) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const { v, p, m, e } = payload as { v?: unknown; p?: unknown; m?: unknown; e?: unknown };
  if (v !== TOKEN_VERSION || !isValidMembershipId(m) || typeof e !== "number" || !Number.isFinite(e)) {
    return { ok: false, reason: "malformed" };
  }
  if (p !== purpose) return { ok: false, reason: "wrong_purpose" };

  const nowMs = (opts?.now ?? new Date()).getTime();
  if (nowMs >= e) return { ok: false, reason: "expired", membershipId: m };

  return { ok: true, membershipId: m };
}

/** Back-compat wrapper: verify strictly as a view-emails token. */
export function verifyViewEmailsOffToken(token: string, opts?: { now?: Date }): VerifyViewEmailsOffTokenResult {
  return verifyForPurpose(VIEW_EMAILS_OFF_PURPOSE, token, opts);
}

/**
 * Verify against every kind and report which one it was.
 *
 * The route needs to know what to switch off, and the token is the only trustworthy place to read
 * that from — a `?kind=` parameter is editable by whoever holds the link, so an unsubscribe link
 * for doc-update mail could be turned into one that switches off view emails instead. Each kind
 * has its own derived key, so exactly one of these can verify a given token.
 *
 * The failure reported is the one from the kind the token *claims* to be (its `p`), so a
 * legitimately expired doc-update token still says "expired" rather than "wrong purpose".
 */
export function verifyAnyEmailsOffToken(token: string, opts?: { now?: Date }): VerifyAnyResult {
  /**
   * Keep the most informative failure, not the first.
   *
   * Each kind is tried in turn, and a token for kind B fails kind A's check at the *signature*,
   * because the keys are derived per purpose. So the first loop iteration on an expired
   * doc-update token reported `bad_signature`, which the route renders as "this link is not
   * valid" — when the truthful page is "this link has expired", which says what to do next.
   *
   * Ranking fixes it: `expired` outranks `bad_signature`, which outranks `malformed`, which
   * outranks `wrong_purpose`. `wrong_purpose` is the least informative of all here — it only
   * means "not this kind", which is the expected answer for every kind but one.
   */
  const RANK: Record<ViewEmailsOffTokenFailure, number> = {
    expired: 3,
    bad_signature: 2,
    malformed: 1,
    wrong_purpose: 0,
  };

  let best: { reason: ViewEmailsOffTokenFailure; membershipId?: string } | null = null;
  for (const kind of Object.keys(EMAIL_OFF_KINDS) as EmailOffKind[]) {
    const res = verifyForPurpose(EMAIL_OFF_KINDS[kind].purpose, token, opts);
    if (res.ok) return { ok: true, kind, membershipId: res.membershipId };
    if (!best || RANK[res.reason] > RANK[best.reason]) {
      best = { reason: res.reason, ...(res.membershipId ? { membershipId: res.membershipId } : {}) };
    }
  }
  return { ok: false, ...(best ?? { reason: "malformed" as const }) };
}

/** Absolute one-click off URL for a membership: `<appUrl>/api/notifications/views/off?t=<token>`. */
export function viewEmailsOffUrl(appUrl: string, membershipId: string, opts?: { now?: Date }): string {
  return emailsOffUrl(appUrl, "views", membershipId, opts);
}

/**
 * The same URL for any kind.
 *
 * One route serves them all: the path still says `views` because it is signed into every
 * unsubscribe link already sent and renaming it would break those, and the token says which kind
 * it is anyway. A cosmetic mismatch is a better trade than a migration of links we cannot reach.
 */
export function emailsOffUrl(
  appUrl: string,
  kind: EmailOffKind,
  membershipId: string,
  opts?: { now?: Date },
): string {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  const token = createEmailsOffToken(kind, membershipId, { now: opts?.now });
  return `${base}/api/notifications/views/off?t=${encodeURIComponent(token)}`;
}
