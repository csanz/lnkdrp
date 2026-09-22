/**
 * Admin API route: `POST /api/admin/users/:userId/plan`
 *
 * Allows admins (or localhost in dev) to override a user's billing plan in MongoDB.
 * This is intended for testing/ops; official access should be Stripe/webhook-driven.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";



/**
 *
 */
export async function POST(request: Request, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { userId } = await ctx.params;
  if (!Types.ObjectId.isValid(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
  const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
  if (plan !== "free" && plan !== "pro") {
    return NextResponse.json({ error: "Invalid plan (expected 'free' or 'pro')" }, { status: 400 });
  }

  /**
   * This route answered `{ ok: true, plan: "pro" }` and changed nothing a customer can feel.
   *
   * `User.plan` is a pre-workspaces field. Entitlement moved to the workspace: `getWorkspacePlan`
   * reads the org's `Subscription` row, and `/api/plan`, `/api/billing/status`, every
   * `checkLimit` and every credit gate follow it. So an admin asked to comp somebody clicked Pro,
   * saw the row flip to "pro", and left a customer sitting on Free limits — while the next admin
   * to open that screen read "pro" and concluded the grant had been applied. Clicking Free on a
   * paying customer was equally empty.
   *
   * Refusing is the honest state until there is a real mechanism. A comp needs to be something
   * `getWorkspacePlan` reads — an override on the workspace, auditable, and understood by the
   * billing crons that reconcile against Stripe — not a fabricated `Subscription` row and not a
   * legacy field with no readers. That is a decision about billing policy, not a patch.
   *
   * `plan` is still validated above so the refusal is about the mechanism, not the request.
   */
  await connectMongo();
  const exists = await UserModel.exists({ _id: new Types.ObjectId(userId) });
  if (!exists) return NextResponse.json({ error: "User not found" }, { status: 404 });

  return NextResponse.json(
    {
      error: "Plan overrides are not supported",
      detail:
        "A workspace's plan comes from its Stripe subscription (getWorkspacePlan). Writing User.plan changes nothing the customer can see, so this route no longer pretends to. Change the subscription in Stripe, or add a workspace-level override the plan resolver reads.",
      requested: plan,
    },
    { status: 501 },
  );
}


