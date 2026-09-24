/**
 * Does this environment actually work?
 *
 * Not a presence check. "The variable is set" is the least interesting thing that can be true of a
 * credential: a rotated Stripe key, a Blob token for the wrong store, a live publishable key
 * beside a test secret key, and a Mongo URI missing its `/lnkdrp` path are all *present* and all
 * wrong — and each one fails later, in production, looking like a different bug. So where a
 * credential can be exercised cheaply, this exercises it.
 *
 * Two callers, one implementation: `/a/env` answers for the deployment you are looking at, which
 * is the only way to check Vercel's own copy of these values; `scripts/preflight-env.ts` answers
 * for a file before you paste it anywhere.
 *
 * Read-only against every service. It creates nothing, sends nothing and charges nothing: Stripe
 * calls are retrievals, OpenAI lists models, Blob lists one entry, and the Google check
 * deliberately presents an authorization code that cannot be valid (see `checkGoogle`).
 *
 * It never returns a secret. Values are described as a length and the last four characters, which
 * is enough to tell two keys apart in a screenshot without putting either in one.
 */
import { MongoClient } from "mongodb";
import { explainMongoAuthzError, isMongoAuthzError, judgeMongoAccess, mongoUriDatabase, type MongoAuthInfo } from "@/lib/db/access";

export type Status = "ok" | "warn" | "fail" | "skip";
export type Group = "URLs" | "Auth" | "Database" | "Payments" | "Storage" | "AI" | "Email" | "Secrets";
export type Result = { name: string; group: Group; status: Status; detail: string };

/** Results accumulate into a local array, so two concurrent requests cannot interleave. */
type Sink = (name: string, group: Group, status: Status, detail: string) => void;

const env = (name: string): string => (process.env[name] ?? "").trim();

/** A value, described without disclosing it. */
const fingerprint = (v: string): string => `${v.length} chars, ends ${v.slice(-4)}`;

/** Required everywhere. A missing one is a failure, not a warning. */
const REQUIRED: Array<[string, Group]> = [
  ["NEXT_PUBLIC_SITE_URL", "URLs"],
  ["NEXTAUTH_URL", "URLs"],
  ["NEXTAUTH_SECRET", "Auth"],
  ["GOOGLE_CLIENT_ID", "Auth"],
  ["GOOGLE_CLIENT_SECRET", "Auth"],
  ["MONGODB_URI", "Database"],
  ["BLOB_READ_WRITE_TOKEN", "Storage"],
  ["OPENAI_API_KEY", "AI"],
  ["STRIPE_SECRET_KEY", "Payments"],
  ["STRIPE_WEBHOOK_SECRET", "Payments"],
  ["STRIPE_PRICE_ID", "Payments"],
  ["CRON_SECRET", "Secrets"],
  ["REALTIME_SECRET", "Secrets"],
  ["LNKDRP_SHARE_PASSWORD_SECRET", "Secrets"],
  ["LNKDRP_ORG_INVITE_TOKEN_SECRET", "Secrets"],
];

/**
 * Wanted, but a deploy without one is not broken - so these warn rather than fail.
 *
 * Two of them used to sit in `REQUIRED` while DEPLOY.md's own table calls them optional, so an
 * operator who configured production exactly as the runbook says opened /a/env and met two red
 * rows with nothing actually wrong. That is worse than saying nothing: a red that is usually noise
 * gets waved through, and the next one is a Stripe key in the wrong mode or a Mongo URI pointing at
 * the wrong database, both of which this module genuinely detects.
 */
const WANTED: Array<[string, Group, string]> = [
  ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Payments", "no current page reads it; set it before adding client-side Stripe"],
  ["STRIPE_PRICE_ID_ANNUAL", "Payments", "the yearly Pro price (12 months for 10); without it /pricing offers monthly only"],
  ["SLACK_CLIENT_ID", "Secrets", "the Slack app's client id; without it and SLACK_CLIENT_SECRET, Add to Slack is hidden"],
  ["SLACK_CLIENT_SECRET", "Secrets", "the Slack app's client secret; without it and SLACK_CLIENT_ID, Add to Slack is hidden"],
  ["LNKDRP_NOTIFICATION_TOKEN_SECRET", "Secrets", "falls back to NEXTAUTH_SECRET, which is deliberate"],
  // RESEND_API_KEY is not here on purpose: `checkEmail` already reports it, and conditionally on
  // EMAIL_TRANSPORT, which is the better answer. One row per variable.
];

function checkPresence(add: Sink) {
  for (const [name, group] of REQUIRED) if (!env(name)) add(name, group, "fail", "not set");
  for (const [name, group, why] of WANTED) if (!env(name)) add(name, group, "warn", `not set - ${why}`);

  // No separate row for the webhook's self-call origin: `NEXT_PUBLIC_SITE_URL` above is required
  // and is the first thing `resolveConfiguredSiteUrl` tries, so a second check could only ever
  // repeat that failure under another name.

  /**
   * Not a pass or a fail, a fact worth stating out loud.
   *
   * This is the one gating flag whose absence silently means "open": unset, anyone who reaches the
   * Google sign-in gets a full account on first visit. The default is deliberate, but a launch
   * meant to sit behind a queue should not discover the door was open by watching strangers sign up.
   */
  const waitlist = env("WAITLIST_ENABLED").toLowerCase();
  const queued = waitlist === "1" || waitlist === "true";
  add("WAITLIST_ENABLED", "Auth", queued ? "ok" : "warn", queued ? "sign-ups join the queue" : "not set - sign-ups are open to anyone who can reach the sign-in");
}

function checkUrls(add: Sink) {
  for (const name of ["NEXT_PUBLIC_SITE_URL", "NEXTAUTH_URL", "NEXT_PUBLIC_APP_URL"]) {
    const v = env(name);
    if (!v) continue;
    // One row per variable, not one per observation: the same name twice in a flat list reads as
    // a bug in the checker rather than two facts about one value.
    try {
      const u = new URL(v);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !local) add(name, "URLs", "fail", `${v}: ${u.protocol}// but production must be https`);
      else if (v.endsWith("/")) add(name, "URLs", "warn", `${v}: the trailing slash builds double-slashed links`);
      else add(name, "URLs", "ok", v);
    } catch {
      add(name, "URLs", "fail", `not a URL: ${v}`);
    }
  }
  const site = env("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");
  const auth = env("NEXTAUTH_URL").replace(/\/$/, "");
  if (site && auth && site !== auth) {
    add("SITE_URL vs NEXTAUTH_URL", "URLs", "warn", `${site} vs ${auth}: sign-in redirects and share links will disagree`);
  }
}

function checkSecretHygiene(add: Sink) {
  const secrets: Array<[string, number]> = [
    ["NEXTAUTH_SECRET", 32],
    ["CRON_SECRET", 24],
    ["CRON_MONITOR_SECRET", 24],
    ["REALTIME_SECRET", 32],
    ["LNKDRP_SHARE_PASSWORD_SECRET", 32],
    ["LNKDRP_ORG_INVITE_TOKEN_SECRET", 32],
    ["LNKDRP_NOTIFICATION_TOKEN_SECRET", 32],
  ];
  for (const [name, min] of secrets) {
    const v = env(name);
    if (!v) continue;
    if (v.length < min) add(name, "Secrets", "fail", `only ${v.length} chars; want ${min}+`);
    else add(name, "Secrets", "ok", fingerprint(v));
  }
  // One secret doing two jobs means one leak is two. DEPLOY section 3 says these must differ.
  const pairs: Array<[string, string]> = [
    ["REALTIME_SECRET", "NEXTAUTH_SECRET"],
    ["CRON_SECRET", "CRON_MONITOR_SECRET"],
    ["LNKDRP_SHARE_PASSWORD_SECRET", "LNKDRP_ORG_INVITE_TOKEN_SECRET"],
  ];
  for (const [a, b] of pairs) {
    if (env(a) && env(a) === env(b)) add(`${a} vs ${b}`, "Secrets", "fail", "identical; they must differ");
  }
}

/**
 * Live and test keys in one deployment is the classic Stripe misconfiguration: checkout succeeds
 * against one mode while the webhook, the prices or the publishable key belong to the other, so
 * money moves and nothing records it.
 */
function checkStripeModes(add: Sink) {
  const sk = env("STRIPE_SECRET_KEY");
  const pk = env("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  const whsec = env("STRIPE_WEBHOOK_SECRET");
  if (whsec && !whsec.startsWith("whsec_")) add("STRIPE_WEBHOOK_SECRET", "Payments", "fail", "does not start with whsec_");
  if (!sk || !pk) return;
  if (!sk.startsWith("sk_")) add("STRIPE_SECRET_KEY", "Payments", "fail", "does not look like a Stripe secret key");
  if (!pk.startsWith("pk_")) add("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Payments", "fail", "does not look like a publishable key");
  const skLive = sk.startsWith("sk_live_");
  const pkLive = pk.startsWith("pk_live_");
  if (skLive !== pkLive) add("Stripe key modes", "Payments", "fail", `secret is ${skLive ? "LIVE" : "test"} but publishable is ${pkLive ? "LIVE" : "test"}`);
  else add("Stripe key modes", "Payments", skLive ? "ok" : "warn", skLive ? "both live" : "both test/sandbox: fine for preview, not production");
}

function checkEmailTransport(add: Sink) {
  const t = env("EMAIL_TRANSPORT");
  if (t === "console") add("EMAIL_TRANSPORT", "Email", "warn", "console: no mail is actually sent");
  else if (!env("RESEND_API_KEY")) add("RESEND_API_KEY", "Email", "warn", "not set; sending will fail at runtime");
}

async function checkMongo(add: Sink, offline: boolean) {
  const uri = env("MONGODB_URI");
  if (!uri) return;
  // Not `new URL()`: a multi-host (non-SRV replica set) string like `mongodb://h1:27017,h2:27017/db`
  // makes it throw on the port, so the path read as empty and this row failed on a correct URI.
  // `mongoUriDatabase` does the same string surgery `src/lib/db/localTarget.ts` does.
  const path = mongoUriDatabase(uri);
  if (!path) add("MONGODB_URI", "Database", "fail", "no database in the path; add the database name, e.g. /lnkdrp-prod (DEPLOY 4.1)");
  if (env("MONGODB_DB_NAME")) add("MONGODB_DB_NAME", "Database", "warn", `set to "${env("MONGODB_DB_NAME")}": it overrides the URI's /${path}`);
  if (offline) return add("MONGODB_URI (connect)", "Database", "skip", "offline");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    // Probe the database the app will actually open: the override when set, else the URI's path.
    const db = client.db(env("MONGODB_DB_NAME") || undefined);
    const names = await db.listCollections({}, { nameOnly: true }).toArray();
    add("MONGODB_URI (connect)", "Database", "ok", `connected to "${db.databaseName}", ${names.length} collections`);
  } catch (e) {
    // Connected but not allowed: the role is on another database name. Ask the server which, so
    // the line says "granted on lnkdrp_dev, URI says lnkdrp-dev" instead of a truncated command dump.
    if (isMongoAuthzError(e)) {
      const message = await client
        .db("admin")
        .command({ connectionStatus: 1, showPrivileges: true })
        .then((s) => judgeMongoAccess(env("MONGODB_DB_NAME") || path, (s as { authInfo?: MongoAuthInfo }).authInfo))
        .then((v) => (v.ok ? explainMongoAuthzError(e, { uri }) : v.message))
        .catch(() => explainMongoAuthzError(e, { uri }));
      add("MONGODB_URI (connect)", "Database", "fail", message);
    } else {
      add("MONGODB_URI (connect)", "Database", "fail", e instanceof Error ? e.message.slice(0, 120) : "connect failed");
    }
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Google credentials, without a browser.
 *
 * The token endpoint is asked to redeem an authorization code that cannot be valid. The reply
 * separates the two failures worth telling apart: `invalid_client` means the id/secret pair is
 * wrong; `invalid_grant` means the pair was accepted and only the code was rejected, which is
 * exactly the proof wanted. Nothing is created and no user is involved.
 */
async function checkGoogle(add: Sink, offline: boolean) {
  const id = env("GOOGLE_CLIENT_ID");
  const secret = env("GOOGLE_CLIENT_SECRET");
  if (!id || !secret) return;
  if (!id.endsWith(".apps.googleusercontent.com")) add("GOOGLE_CLIENT_ID", "Auth", "warn", "does not end in .apps.googleusercontent.com");
  if (offline) return add("Google sign-in", "Auth", "skip", "offline");
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "authorization_code",
        code: "preflight-invalid-code",
        redirect_uri: `${env("NEXTAUTH_URL") || "https://lnkdrp.com"}/api/auth/callback/google`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (body.error === "invalid_grant") add("Google sign-in", "Auth", "ok", "id and secret accepted by Google");
    else if (body.error === "invalid_client") add("Google sign-in", "Auth", "fail", "Google rejected the id/secret pair");
    else add("Google sign-in", "Auth", "warn", `unexpected: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  } catch (e) {
    add("Google sign-in", "Auth", "warn", e instanceof Error ? e.message.slice(0, 80) : "request failed");
  }
}

/**
 * Does the signing secret belong to a webhook endpoint that actually exists?
 *
 * Checking the `whsec_` prefix proves nothing: a *wrong* secret is the same shape as a right one,
 * and it fails silently at the worst moment — Stripe takes the payment, the delivery bounces on
 * signature verification, and the product never turns Pro on. That happened here, from a clipboard
 * overwritten between copying the secret and pasting it.
 *
 * The secret itself cannot be read back from the API, so this checks the half that can be: whether
 * any enabled endpoint points at this deployment at all, and whether it carries the events the
 * webhook handler needs. An endpoint that is missing, disabled, pointed at the apex (which
 * 308-redirects, and webhook POSTs do not reliably follow) or short on events is a real failure
 * with the same symptom, and all of those are visible from here.
 */
async function checkStripeWebhook(add: Sink, offline: boolean) {
  const sk = env("STRIPE_SECRET_KEY");
  const site = env("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");
  if (!sk || offline || !site) return;
  const REQUIRED_EVENTS = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ];
  try {
    const res = await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=50", {
      headers: { authorization: `Bearer ${sk}` },
    });
    if (!res.ok) return add("Stripe webhook", "Payments", "warn", `could not list endpoints (${res.status})`);
    const body = (await res.json()) as { data?: Array<{ url?: string; status?: string; enabled_events?: string[] }> };
    const want = `${site}/api/stripe/webhook`;
    const mine = (body.data ?? []).filter((e) => (e.url ?? "").replace(/\/$/, "") === want);
    if (!mine.length) {
      const others = (body.data ?? []).map((e) => e.url).filter(Boolean).slice(0, 3).join(", ");
      return add("Stripe webhook", "Payments", "fail", `no endpoint for ${want}${others ? `; found: ${others}` : ""}`);
    }
    const enabled = mine.find((e) => e.status === "enabled") ?? mine[0];
    if (enabled.status !== "enabled") return add("Stripe webhook", "Payments", "fail", `endpoint exists but is ${enabled.status}`);
    const missing = REQUIRED_EVENTS.filter((ev) => !(enabled.enabled_events ?? []).includes(ev) && !(enabled.enabled_events ?? []).includes("*"));
    if (missing.length) return add("Stripe webhook", "Payments", "fail", `endpoint is missing ${missing.join(", ")}`);
    add("Stripe webhook", "Payments", "ok", `enabled endpoint for this site, ${(enabled.enabled_events ?? []).length} events`);
  } catch (e) {
    add("Stripe webhook", "Payments", "warn", e instanceof Error ? e.message.slice(0, 80) : "request failed");
  }
}

async function checkStripeLive(add: Sink, offline: boolean) {
  const sk = env("STRIPE_SECRET_KEY");
  if (!sk) return;
  if (offline) return add("Stripe API", "Payments", "skip", "offline");
  const call = (path: string) => fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${sk}` } });
  try {
    const acct = await call("account");
    if (!acct.ok) {
      const b = (await acct.json().catch(() => ({}))) as { error?: { message?: string } };
      return add("Stripe API", "Payments", "fail", `${acct.status}: ${b.error?.message ?? "rejected"}`);
    }
    const a = (await acct.json()) as { id?: string; charges_enabled?: boolean; settings?: { dashboard?: { display_name?: string } } };
    add("Stripe API", "Payments", "ok", `${a.id} (${a.settings?.dashboard?.display_name ?? "no display name"})`);
    if (sk.startsWith("sk_live_") && a.charges_enabled === false) {
      add("Stripe activation", "Payments", "fail", "live key but charges_enabled=false: the account cannot take payments (DEPLOY 4.2)");
    }
    // Each price must exist in the same mode as the key, or Checkout fails at the worst moment.
    for (const name of ["STRIPE_PRICE_ID", "STRIPE_PRICE_ID_ANNUAL", "STRIPE_AI_CREDITS_PRICE_ID", "STRIPE_USAGE_PRICE_ID"]) {
      const id = env(name);
      if (!id) continue;
      const res = await call(`prices/${encodeURIComponent(id)}`);
      if (!res.ok) {
        add(name, "Payments", "fail", `${res.status}: not found with this key (wrong mode, or wrong id)`);
        continue;
      }
      const p = (await res.json()) as {
        active?: boolean;
        currency?: string;
        unit_amount?: number | null;
        recurring?: { usage_type?: string; interval?: string } | null;
      };
      const bits = [
        p.currency?.toUpperCase(),
        p.unit_amount != null ? (p.unit_amount / 100).toFixed(2) : "metered",
        p.recurring?.interval ? `per ${p.recurring.interval}` : null,
        p.active ? "active" : "INACTIVE",
        p.recurring?.usage_type,
      ];
      // The annual price must bill yearly and be licensed, or Checkout builds a subscription that
      // bills monthly under a yearly label. Say so here, not on the first customer.
      const wrongShape =
        name === "STRIPE_PRICE_ID_ANNUAL" && (p.recurring?.interval !== "year" || p.recurring?.usage_type === "metered");
      const status = p.active === false || wrongShape ? "fail" : "ok";
      add(name, "Payments", status, wrongShape ? `${bits.filter(Boolean).join(" · ")}; must be a licensed price with interval=year` : bits.filter(Boolean).join(" · "));
    }
  } catch (e) {
    add("Stripe API", "Payments", "fail", e instanceof Error ? e.message.slice(0, 100) : "request failed");
  }
}

async function checkOpenAI(add: Sink, offline: boolean) {
  const key = env("OPENAI_API_KEY");
  if (!key) return;
  if (offline) return add("OPENAI_API_KEY", "AI", "skip", "offline");
  try {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    add("OPENAI_API_KEY", "AI", res.ok ? "ok" : "fail", res.ok ? `accepted (${fingerprint(key)})` : `${res.status}: rejected`);
  } catch (e) {
    add("OPENAI_API_KEY", "AI", "warn", e instanceof Error ? e.message.slice(0, 80) : "request failed");
  }
}

async function checkBlob(add: Sink, offline: boolean) {
  const token = env("BLOB_READ_WRITE_TOKEN");
  if (!token) return;
  if (offline) return add("BLOB_READ_WRITE_TOKEN", "Storage", "skip", "offline");
  try {
    const { list } = await import("@vercel/blob");
    const res = await list({ token, limit: 1 });
    const host = res.blobs[0]?.url ? new URL(res.blobs[0].url).host : "(store is empty)";
    add("BLOB_READ_WRITE_TOKEN", "Storage", "ok", `store reachable: ${host}`);
    const base = env("BLOB_BASE_URL");
    if (base && res.blobs[0]?.url && !res.blobs[0].url.startsWith(base.replace(/\/$/, ""))) {
      add("BLOB_BASE_URL", "Storage", "fail", `${base} does not match the store this token opens (${host})`);
    }
  } catch (e) {
    add("BLOB_READ_WRITE_TOKEN", "Storage", "fail", e instanceof Error ? e.message.slice(0, 100) : "rejected");
  }
}

async function checkResend(add: Sink, offline: boolean) {
  const key = env("RESEND_API_KEY");
  if (!key || offline) return;
  try {
    const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return add("RESEND_API_KEY", "Email", "fail", `${res.status}: rejected`);
    const body = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
    const domains = body.data ?? [];
    const verified = domains.filter((d) => d.status === "verified").map((d) => d.name).filter(Boolean) as string[];
    if (!domains.length) add("RESEND_API_KEY", "Email", "warn", "accepted, but no sending domain configured (DEPLOY 4.6)");
    else if (!verified.length) add("RESEND_API_KEY", "Email", "fail", `no verified domain: ${domains.map((d) => `${d.name}=${d.status}`).join(", ")}`);
    else add("RESEND_API_KEY", "Email", "ok", `verified: ${verified.join(", ")}`);
    for (const name of ["NOTIFICATION_EMAIL_FROM", "INVITE_EMAIL_FROM"]) {
      const from = env(name);
      if (!from) continue;
      const domain = from.split("@")[1]?.replace(/>.*$/, "").trim();
      if (domain && verified.length && !verified.some((v) => domain.endsWith(v))) {
        add(name, "Email", "fail", `sends from @${domain}, not a verified Resend domain`);
      }
    }
  } catch (e) {
    add("RESEND_API_KEY", "Email", "warn", e instanceof Error ? e.message.slice(0, 80) : "request failed");
  }
}

/** Run every check. `offline` skips the network ones and is what a unit test uses. */
export async function runEnvPreflight(opts: { offline?: boolean } = {}): Promise<Result[]> {
  const offline = opts.offline === true;
  const results: Result[] = [];
  const add: Sink = (name, group, status, detail) => results.push({ name, group, status, detail });

  checkPresence(add);
  checkUrls(add);
  checkSecretHygiene(add);
  checkStripeModes(add);
  checkEmailTransport(add);
  // Concurrent because they are independent network calls and this runs behind a page load.
  await Promise.all([
    checkMongo(add, offline),
    checkGoogle(add, offline),
    checkStripeLive(add, offline),
    checkStripeWebhook(add, offline),
    checkOpenAI(add, offline),
    checkBlob(add, offline),
    checkResend(add, offline),
  ]);

  const order: Status[] = ["fail", "warn", "ok", "skip"];
  return results.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
}

/** The one-line answer, for a header or an exit code. */
export function summarise(results: Result[]): { fail: number; warn: number; ok: number; skip: number; healthy: boolean } {
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const fail = count("fail");
  return { fail, warn: count("warn"), ok: count("ok"), skip: count("skip"), healthy: fail === 0 };
}
