/**
 * `/welcome` — the one screen a new account sees before the app.
 *
 * Two questions, and both of them are things that are *wrong* by default rather than merely unset:
 * the name we got from the sign-in provider is often not the name someone wants on a shared
 * document, and whether they hear about an open in minutes or tomorrow morning decides whether the
 * product is an alert or a report. Everything else has a sensible default and a home in the
 * dashboard, and is deliberately not asked here — a setup wizard that asks nine questions is a
 * wall in front of the thing someone came to do.
 *
 * Skipping is a first-class outcome. The screen stamps itself done either way (`markFirstRunDone`),
 * because a setup step that comes back until it gets its way is not a setup step.
 *
 * Standalone, outside `(app)`: the sidebar is navigation for a workspace nobody has used yet.
 * Reached by the redirect in `src/app/(app)/layout.tsx`, the same way `/waitlist` is.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { userNeedsFirstRun } from "@/lib/onboarding/firstRun";
import WelcomeClient from "./WelcomeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up LinkDrop",
  description: "Two things worth deciding before you share your first document.",
};

export default async function WelcomePage() {
  const session = await getServerSession(authOptions);
  const userId = typeof session?.user?.id === "string" ? session.user.id : "";
  if (!userId) redirect("/login");

  // Already done, or an account from before this screen existed: there is nothing to set up, and
  // landing here from a bookmark should not look like an unfinished task.
  if (!(await userNeedsFirstRun(userId))) redirect("/");

  await connectMongo();
  const user = (await UserModel.findById(userId).select({ name: 1, email: 1 }).lean()) as
    | { name?: string | null; email?: string | null }
    | null;

  const full = (user?.name ?? "").trim();
  const cut = full.indexOf(" ");
  return (
    <WelcomeClient
      firstName={cut > 0 ? full.slice(0, cut) : full}
      lastName={cut > 0 ? full.slice(cut + 1).trim() : ""}
      email={(user?.email ?? "").trim()}
    />
  );
}
