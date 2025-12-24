import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel, createTempUser, verifyTempUserSecret } from "@/models/User";

export const TEMP_USER_ID_HEADER = "x-temp-user-id";
export const TEMP_USER_SECRET_HEADER = "x-temp-user-secret";

export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "temp"; userId: string; temp: { id: string; secret?: string }; isNew: boolean };

function isAuthConfigured() {
  // Mirrors the client-side `enableAuth` guard in `src/app/layout.tsx`.
  return (
    Boolean(process.env.MONGODB_URI) &&
    Boolean(process.env.NEXTAUTH_SECRET) &&
    Boolean(process.env.GOOGLE_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_CLIENT_SECRET)
  );
}

async function tryGetSessionUserId(request: Request): Promise<string | null> {
  if (!isAuthConfigured()) return null;
  try {
    /**
     * In Next.js route handlers, `getServerSession()` can be unreliable across versions
     * because it depends on framework request context wiring.
     *
     * Reading the NextAuth JWT directly from the incoming Request cookies is
     * deterministic and works for both API routes and background tasks that still
     * have access to the original Request.
     */
    const { getToken } = await import("next-auth/jwt");
    const token = await getToken({
      // `getToken` supports both NextRequest and NextApiRequest shapes. Our route
      // handlers use the Web `Request` type; it includes `headers` with `cookie`.
      req: request as unknown as Parameters<typeof getToken>[0]["req"],
      secret: process.env.NEXTAUTH_SECRET,
    });
    const id = (token as unknown as { userId?: unknown; sub?: unknown } | null)?.userId;
    const fallbackSub = (token as unknown as { userId?: unknown; sub?: unknown } | null)?.sub;
    const resolved = typeof id === "string" && id ? id : typeof fallbackSub === "string" ? fallbackSub : null;
    return typeof resolved === "string" && resolved ? resolved : null;
  } catch {
    return null;
  }
}

function header(request: Request, name: string) {
  return request.headers.get(name) ?? request.headers.get(name.toLowerCase());
}

export function applyTempUserHeaders(
  res: Response,
  actor: Actor,
): Response {
  if (actor.kind !== "temp") return res;
  if (!actor.isNew) return res;
  if (!actor.temp.secret) return res;
  res.headers.set(TEMP_USER_ID_HEADER, actor.temp.id);
  res.headers.set(TEMP_USER_SECRET_HEADER, actor.temp.secret);
  return res;
}

/**
 * Resolve the current "actor" for an API request:
 * - signed-in user (NextAuth session), else
 * - temp user (by headers), else
 * - create a new temp user.
 */
export async function resolveActor(request: Request): Promise<Actor> {
  // 1) Authenticated user (preferred)
  const sessionUserId = await tryGetSessionUserId(request);
  if (sessionUserId) return { kind: "user", userId: sessionUserId };

  // 2) Temp user via headers
  const tempId = header(request, TEMP_USER_ID_HEADER);
  const tempSecret = header(request, TEMP_USER_SECRET_HEADER);
  if (tempId && tempSecret && Types.ObjectId.isValid(tempId)) {
    await connectMongo();
    const u = await UserModel.findOne({ _id: new Types.ObjectId(tempId), isTemp: true })
      .select({ _id: 1, tempSecretHash: 1 })
      .lean();

    if (u && verifyTempUserSecret({ secret: tempSecret, secretHash: u.tempSecretHash ?? null })) {
      return { kind: "temp", userId: String(u._id), temp: { id: String(u._id) }, isNew: false };
    }
  }

  // 3) Create a new temp user
  await connectMongo();
  const created = await createTempUser();
  return {
    kind: "temp",
    userId: created.id,
    temp: { id: created.id, secret: created.secret },
    isNew: true,
  };
}



