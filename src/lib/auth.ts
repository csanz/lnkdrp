import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

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
 * NextAuth configuration for the app.
 *
 * - Uses Google OAuth
 * - Persists/derives app-specific claims (user id + role) from MongoDB
 * - Denies sign-in for explicitly disabled users
 */
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
