/**
 * Page for `/metrics` (authenticated app shell): workspace-wide metrics, the overview above the
 * per-document metrics pages (docs/prds/lnkdrp-workspace-metrics.md).
 *
 * The body is a client component — it reads the remembered range from `localStorage` and refetches
 * on realtime activity — so this file only names the route.
 */
import type { Metadata } from "next";

import MetricsPageClient from "./pageClient";

export const metadata: Metadata = { title: "Metrics" };

/** The `/metrics` route. */
export default function MetricsPage() {
  return <MetricsPageClient />;
}
