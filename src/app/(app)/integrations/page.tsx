/**
 * Page for `/integrations` (authenticated app shell).
 *
 * The tools this workspace posts to. Slack is the first (docs/prds/lnkdrp-slack.md); the list is
 * data-driven so the next one is one more entry.
 */
import type { Metadata } from "next";

import { slackStateForPage } from "@/lib/slack/pageState";
import IntegrationsPageClient from "./pageClient";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  // Resolved here so the first paint already says Manage or Set up; see `slackStateForPage`.
  const initialSlack = await slackStateForPage();
  return <IntegrationsPageClient initialSlack={initialSlack} />;
}
