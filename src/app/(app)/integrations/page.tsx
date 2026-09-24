/**
 * Page for `/integrations` (authenticated app shell).
 *
 * The tools this workspace posts to. Slack is the first (docs/prds/lnkdrp-slack.md); the list is
 * data-driven so the next one is one more entry.
 */
import type { Metadata } from "next";

import IntegrationsPageClient from "./pageClient";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return <IntegrationsPageClient />;
}
