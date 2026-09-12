import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import crypto from "node:crypto";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

/**
 * Invite-gating cookie.
 *
 * Set by `/api/invites/verify` after a valid invite code is entered; read by the NextAuth route
 * gate and by the `signIn` callback below. The value is HMAC-signed so a caller cannot mint one:
 * `<inviteId>.<expiresUnix>.<hmacHex>`.
 */
export const INVITE_COOKIE_NAME = "ld_invite_ok";
/** Lifetime of a freshly issued invite cookie (seconds). */
export const INVITE_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 14; // 14 days

/** Return the secret used to sign invite cookies (throws in production if missing). */
function inviteCookieSecret(): string {
  const s = process.env.LNKDRP_ORG_INVITE_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;
  // Dev fallback so local envs don't crash (mirrors org-invite token handling).
  if (process.env.NODE_ENV !== "production") return "dev-lnkrdp-org-invite-token-secret";
  throw new Error("Missing LNKDRP_ORG_INVITE_TOKEN_SECRET (or NEXTAUTH_SECRET) for invite cookies");
}

/** Compute the HMAC-SHA256 (hex) over the signed portion of an invite cookie. */
function inviteCookieHmac(payload: string): string {
  return crypto.createHmac("sha256", inviteCookieSecret()).update(payload).digest("hex");
}

/**
 * Build a signed invite cookie value: `<inviteId>.<expiresUnix>.<hmac>`.
 *
 * `inviteId` must not contain `.`; ObjectId strings never do.
 */
export function signInviteCookieValue(opts: { inviteId: string; ttlSec?: number; now?: number }): string {
  const inviteId = String(opts.inviteId ?? "").trim();
  if (!inviteId || inviteId.includes(".")) throw new Error("Invalid inviteId for invite cookie");
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const ttlSec = typeof opts.ttlSec === "number" && opts.ttlSec > 0 ? Math.floor(opts.ttlSec) : INVITE_COOKIE_MAX_AGE_SEC;
  const expiresUnix = Math.floor(now / 1000) + ttlSec;
  const payload = `${inviteId}.${expiresUnix}`;
  return `${payload}.${inviteCookieHmac(payload)}`;
}

/**
 * Verify a signed invite cookie value (signature + expiry) in constant time.
 *
 * Returns `{ ok: false }` for anything malformed, tampered, expired, or legacy (`"1"`).
 */
export function verifyInviteCookieValue(
  value: string | null | undefined,
  now: number = Date.now(),
): { ok: true; inviteId: string; expiresAt: Date } | { ok: false } {
  if (typeof value !== "string" || !value) return { ok: false };
  const parts = value.split(".");
  if (parts.length !== 3) return { ok: false };
  const [inviteId, expiresRaw, sig] = parts;
  if (!inviteId || !/^\d+$/.test(expiresRaw) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false };

  const expiresUnix = Number(expiresRaw);
  if (!Number.isFinite(expiresUnix) || expiresUnix * 1000 <= now) return { ok: false };

  let expected: string;
  try {
    expected = inviteCookieHmac(`${inviteId}.${expiresRaw}`);
  } catch {
    return { ok: false };
  }
  const a = Buffer.from(sig.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };

  return { ok: true, inviteId, expiresAt: new Date(expiresUnix * 1000) };
}

/**
 * Read the invite cookie for the request currently being handled (NextAuth callbacks don't receive
 * the request). Returns `null` outside a request scope.
 */
async function readInviteCookieFromRequestScope(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    return store.get(INVITE_COOKIE_NAME)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort backfill of `NEXTAUTH_URL` in development.
 *
 * Exists to silence noisy NextAuth dev warnings when running locally without full env config.
 * Side effects: mutates `process.env.NEXTAUTH_URL` when it can infer a valid base URL.
 */
function ensureDevNextAuthUrl() {
  if (process.env.NEXTAUTH_URL) return;
  // This avoids noisy dev warnings; production should always set NEXTAUTH_URL explicitly.
  const raw =
    (process.env.NEXT_PUBLIC_SITE_URL || "").trim() ||
    (process.env.NEXT_PUBLIC_APP_URL || "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3001" : "");
  if (!raw) return;
  try {
    // Also accept scheme-less values like "localhost:3001".
    const url = raw.includes("://") ? raw : raw.startsWith("localhost") ? `http://${raw}` : `https://${raw}`;
    process.env.NEXTAUTH_URL = new URL(url).toString();
  } catch {
    // ignore
  }
}
ensureDevNextAuthUrl();

/**
 * Return an environment variable or throw with a clear configuration error.
 */
function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast on misconfiguration (production-safe).
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/** Minimal Google profile shape used by our sign-in callback. */
type GoogleProfileShape = {
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  sub?: string | null;
};

/**
 * NextAuth configuration for the app (Google OAuth + Mongo-backed claims).
 *
 * Exists to keep auth stateless (JWT sessions) while enriching tokens with app-specific claims
 * (user id, role, active org). Side effects: may upsert user records and validate org membership
 * during `session.update` triggers.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: mustGetEnv("GOOGLE_CLIENT_ID"),
      clientSecret: mustGetEnv("GOOGLE_CLIENT_SECRET"),
    }),
  ],

  secret: mustGetEnv("NEXTAUTH_SECRET"),

  // JWT sessions are the default and work well on Vercel (stateless).
  session: { strategy: "jwt" },

  callbacks: {
    /**
     * Allow Google sign-in and upsert a user record by email.
     * Returns `false` to deny sign-in (e.g. missing profile info or disabled user).
     */
    async signIn({ account, profile }) {
      if (!account || account.provider !== "google") return false;

      const p = (profile ?? {}) as GoogleProfileShape;
      const email = p.email?.toLowerCase().trim();
      if (!email) return false;

      // For Google, NextAuth sets providerAccountId to the stable "sub".
      const providerAccountId = account.providerAccountId?.trim();
      if (!providerAccountId) return false;

      await connectMongo();

      // If a user is disabled, deny sign-in without mutating the record.
      const existing = await UserModel.findOne({ email })
        .select({ _id: 1, isActive: 1 })
        .lean();
      if (existing && existing.isActive === false) return false;

      // Invite gate for NEW users: the `/api/auth/*` route gate checks the same cookie, but the
      // callback is the last line of defense (e.g. a cookie that expired mid-OAuth-dance).
      // Existing users may always sign in. Mirrors the route gate: enforced in production only.
      if (!existing && process.env.NODE_ENV === "production") {
        const inviteCookie = await readInviteCookieFromRequestScope();
        if (!verifyInviteCookieValue(inviteCookie).ok) return false;
      }

      const now = new Date();

      const setFields: Record<string, unknown> = {
        name: p.name ?? undefined,
        lastLoginAt: now,
      };
      // Only set image if we received a usable value; don't overwrite an existing image with `undefined`.
      if (typeof p.picture === "string" && p.picture.trim()) {
        setFields.image = p.picture.trim();
      }

      // Idempotent upsert by email:
      // - createdAt is only set on first creation ($setOnInsert)
      // - lastLoginAt is always updated
      await UserModel.findOneAndUpdate(
        { email },
        {
          $setOnInsert: {
            email,
            authProvider: "google",
            providerAccountId,
            createdAt: now,
            isActive: true,
            role: "user",
            onboardingCompleted: false,
            metadata: {},
          },
          $set: setFields,
        },
        { upsert: true, new: true },
      );

      return true;
    },

    /**
     * Attach app-specific claims to the JWT (Mongo user id + role).
     * Loads them from MongoDB on initial sign-in (or if missing).
     */
    async jwt({ token, account, trigger, session, profile }) {
      // Attach app-specific claims to the JWT:
      // - userId (Mongo ObjectId as string)
      // - role
      if (!token.email) return token;

      const t = token as typeof token & { picture?: unknown; name?: unknown };
      // Best-effort: on sign-in, capture the provider picture into the token immediately.
      if (account?.provider === "google" && (!t.picture || typeof t.picture !== "string")) {
        const p = (profile ?? {}) as GoogleProfileShape;
        if (typeof p.picture === "string" && p.picture.trim()) {
          t.picture = p.picture.trim();
        }
      }

      // Allow client-driven session updates (e.g. org switching) but validate membership server-side.
      if (trigger === "update" && session) {
        const rawTop = (session as unknown as { activeOrgId?: unknown }).activeOrgId;
        const rawUser = (session as unknown as { user?: { activeOrgId?: unknown } | null }).user?.activeOrgId;
        const nextOrgId = typeof rawUser === "string" ? rawUser.trim() : typeof rawTop === "string" ? rawTop.trim() : "";
        if (nextOrgId && Types.ObjectId.isValid(nextOrgId) && typeof token.userId === "string" && token.userId) {
          await connectMongo();
          const ok = await OrgMembershipModel.exists({
            orgId: new Types.ObjectId(nextOrgId),
            userId: new Types.ObjectId(token.userId),
            isDeleted: { $ne: true },
          });
          if (ok) token.activeOrgId = nextOrgId;
        }

        // Allow client-driven session updates for display name (e.g. dashboard "Edit name").
        const nextNameRaw = (session as unknown as { user?: { name?: unknown } | null })?.user?.name;
        const nextName = typeof nextNameRaw === "string" ? nextNameRaw.trim() : "";
        if (nextName && nextName.length <= 120) {
          // NextAuth's token `name` is typed as unknown; keep it in sync so the session reflects updates.
          (token as typeof token & { name?: unknown }).name = nextName;
        }
      }

      // On initial sign-in (or if claims are missing), load from DB.
      if (account || !token.userId || !token.role || !token.activeOrgId || !t.picture) {
        await connectMongo();
        const email = token.email.toLowerCase().trim();

        const dbUser = await UserModel.findOne({ email })
          .select({ _id: 1, role: 1, name: 1, image: 1 })
          .lean();

        if (dbUser) {
          token.userId = dbUser._id.toString();
          token.role = (dbUser.role as string) ?? "user";

          // Keep the token's built-in fields hydrated so the session has name/image reliably.
          if ((!t.name || typeof t.name !== "string") && typeof dbUser.name === "string" && dbUser.name.trim()) {
            t.name = dbUser.name.trim();
          }
          if ((!t.picture || typeof t.picture !== "string") && typeof (dbUser as unknown as { image?: unknown }).image === "string") {
            const img = String((dbUser as unknown as { image?: string }).image).trim();
            if (img) t.picture = img;
          }

          // Ensure a personal org exists and set activeOrgId by default.
          if (!token.activeOrgId) {
            const { orgId } = await ensurePersonalOrgForUserId({
              userId: new Types.ObjectId(token.userId),
              name: "Personal",
            });
            token.activeOrgId = String(orgId);
          }
        }
      }

      // If the token somehow still has no activeOrgId, backfill from personal org (best-effort).
      if (!token.activeOrgId && typeof token.userId === "string" && token.userId) {
        await connectMongo();
        const { orgId } = await ensurePersonalOrgForUserId({ userId: new Types.ObjectId(token.userId) });
        token.activeOrgId = String(orgId);
      }

      return token;
    },

    /**
     * Map JWT claims onto the session object returned to the client.
     * Keeps the client session minimal and stable.
     */
    async session({ session, token }) {
      // Expose a stable, minimal session shape to the frontend.
      const t = token as typeof token & { picture?: unknown };
      if (session.user) {
        session.user.id = typeof token.userId === "string" ? token.userId : "";
        session.user.role = typeof token.role === "string" ? token.role : "user";

        // Ensure email is always present/consistent.
        if (typeof token.email === "string") {
          session.user.email = token.email;
        }

        // Ensure image is present for new accounts (NextAuth stores it on `token.picture`).
        if (
          (session.user.image === null || session.user.image === undefined || session.user.image === "") &&
          typeof t.picture === "string" &&
          t.picture.trim()
        ) {
          session.user.image = t.picture.trim();
        }
      }

      if (typeof token.activeOrgId === "string" && token.activeOrgId) {
        session.activeOrgId = token.activeOrgId;
      }

      return session;
    },
  },
};
