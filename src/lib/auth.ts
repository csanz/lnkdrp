import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/models/User";

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast on misconfiguration (production-safe).
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

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
          $set: {
            name: p.name ?? undefined,
            image: p.picture ?? undefined,
            lastLoginAt: now,
          },
        },
        { upsert: true, new: true },
      );

      return true;
    },

    async jwt({ token, account }) {
      // Attach app-specific claims to the JWT:
      // - userId (Mongo ObjectId as string)
      // - role
      if (!token.email) return token;

      // On initial sign-in (or if claims are missing), load from DB.
      if (account || !token.userId || !token.role) {
        await connectMongo();
        const email = token.email.toLowerCase().trim();

        const dbUser = await UserModel.findOne({ email })
          .select({ _id: 1, role: 1 })
          .lean();

        if (dbUser) {
          token.userId = dbUser._id.toString();
          token.role = (dbUser.role as string) ?? "user";
        }
      }

      return token;
    },

    async session({ session, token }) {
      // Expose a stable, minimal session shape to the frontend.
      if (session.user) {
        session.user.id = typeof token.userId === "string" ? token.userId : "";
        session.user.role = typeof token.role === "string" ? token.role : "user";

        // Ensure email is always present/consistent.
        if (typeof token.email === "string") {
          session.user.email = token.email;
        }
      }

      return session;
    },
  },
};



