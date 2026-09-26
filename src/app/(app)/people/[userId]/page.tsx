/**
 * Page for `/people/:userId` - one member, and everything they have done in this workspace.
 *
 * The id is validated here rather than in the client: `keyFromRoute` is the same parser the API
 * and the MCP use, so a hand-typed or truncated id is a 404 in the app shell instead of a page
 * that renders a header and then fails a fetch. What it does *not* do is check that the member
 * exists or belongs to this workspace - that is the profile endpoint's job, because only it knows
 * the active org, and it answers 404 for a member with no activity here so a foreign id cannot be
 * used to probe.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import ActorPageClient from "@/components/people/ActorPageClient";
import { formatContributorKey, keyFromRoute } from "@/lib/people/contributorKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Person" };

/** The `/people/:userId` route. */
export default async function PersonPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const key = keyFromRoute({ userId: decodeURIComponent(userId ?? "") });
  if (!key) notFound();
  return <ActorPageClient actorKey={formatContributorKey(key)} />;
}
