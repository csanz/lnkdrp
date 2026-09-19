/**
 * Dev-only: print a NextAuth session cookie value for a local account.
 *
 * For driving the signed-in UI in a headless browser while debugging. Local dev secret, local dev
 * database; it is not a way into anything that is not already on this machine.
 */
import { encode } from "next-auth/jwt";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";

async function main() {
  await connectMongo();
  const email = (process.argv[2] ?? "").toLowerCase();
  const u = (await UserModel.findOne({ email }).select({ _id: 1, name: 1, email: 1, role: 1, metadata: 1 }).lean()) as
    | { _id: unknown; name?: string; email?: string; role?: string; metadata?: { activeOrgId?: unknown } }
    | null;
  if (!u) throw new Error(`no user ${email}`);
  const token = await encode({
    token: {
      name: u.name ?? null,
      email: u.email,
      sub: String(u._id),
      userId: String(u._id),
      role: u.role ?? "user",
      activeOrgId: String(u?.metadata?.activeOrgId ?? ""),
    },
    secret: process.env.NEXTAUTH_SECRET as string,
    maxAge: 1800,
  });
  console.log(token);
  process.exit(0);
}
void main();
