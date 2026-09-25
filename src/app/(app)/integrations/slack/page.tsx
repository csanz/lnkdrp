/**
 * Page for `/integrations/slack`: connect channels, choose what posts, route projects.
 * The OAuth callback lands here with `?slack=connected` or `?slack=error&reason=…`.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import { slackStateForPage } from "@/lib/slack/pageState";
import SlackPageClient from "./pageClient";

export const metadata: Metadata = { title: "Slack" };
export const dynamic = "force-dynamic";

export default async function SlackIntegrationPage() {
  const initialSlack = await slackStateForPage();
  return (
    <Suspense fallback={null}>
      <SlackPageClient initialSlack={initialSlack} />
    </Suspense>
  );
}
