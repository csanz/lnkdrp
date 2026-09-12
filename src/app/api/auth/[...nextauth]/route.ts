import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";

// Force Node.js runtime (Mongoose isn't compatible with Edge runtime).
export const runtime = "nodejs";

const handler = NextAuth(authOptions);

/**
 * Handle GET requests (delegates to NextAuth).
 */
export async function GET(req: NextRequest, ctx: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}

/**
 * Handle POST requests (delegates to NextAuth).
 */
export async function POST(req: NextRequest, ctx: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}
