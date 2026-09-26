/**
 * Page for `/agents/:client/:ownerUserId` - one MCP client, as connected by one member.
 *
 * Two segments, not one, because an agent is only a contributor in the company of the person who
 * connected it: two members who each connect Claude Code are two contributors with two pages, and
 * a single `/agents/claude-code` would print one member's filing under the other's name. The owner
 * segment may be the literal `unknown`, which is a real page (rows written by a credential whose
 * creator was never recorded), just one with no person to link back to.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import ActorPageClient from "@/components/people/ActorPageClient";
import { formatContributorKey, keyFromRoute } from "@/lib/people/contributorKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Agent" };

/** The `/agents/:client/:ownerUserId` route. */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ client: string; ownerUserId: string }>;
}) {
  const { client, ownerUserId } = await params;
  const key = keyFromRoute({
    client: decodeURIComponent(client ?? ""),
    ownerUserId: decodeURIComponent(ownerUserId ?? ""),
  });
  if (!key) notFound();
  return <ActorPageClient actorKey={formatContributorKey(key)} />;
}
