/**
 * Page for `/integrations/slack`: connect channels, choose what posts, route projects.
 * The OAuth callback lands here with `?slack=connected` or `?slack=error&reason=…`.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import SlackPageClient from "./pageClient";

export const metadata: Metadata = { title: "Slack" };

export default function SlackIntegrationPage() {
  return (
    <Suspense fallback={null}>
      <SlackPageClient />
    </Suspense>
  );
}
