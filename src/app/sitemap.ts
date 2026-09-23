/**
 * `sitemap.xml`: every public page, and nothing else.
 *
 * Two readers. Search engines, for the marketing pages. And Plain's AI support agent, which is
 * given this one URL as its knowledge source and indexes every page listed here, so a new help
 * article or MCP guide reaches support answers by being added to the site, with no step in Plain.
 *
 * Recipient routes (`/s/…`, `/p/…`, and the rest of `RECIPIENT_PATHS` in `robots.ts`) are
 * deliberately absent: a sitemap is a list of things to fetch, and those must not be fetched.
 * So is everything behind sign-in.
 */
import type { MetadataRoute } from "next";

import { listHelpArticles } from "@/lib/help/articles";
import { CLIENT_SETUPS } from "@/lib/mcp/clientSetups";
import { getPublicSiteBase } from "@/lib/urls";

/** Public pages that are not generated from content. */
const STATIC_PATHS = ["/", "/about", "/pricing", "/costs", "/credits", "/mcp", "/help", "/support", "/privacy", "/tos"] as const;

/** Build the sitemap Next serves at `/sitemap.xml`. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (getPublicSiteBase() || "https://lnkdrp.com").replace(/\/+$/, "");
  const url = (p: string) => `${base}${p}`;
  return [
    ...STATIC_PATHS.map((p) => ({ url: url(p) })),
    ...CLIENT_SETUPS.map((c) => ({ url: url(`/mcp/${c.slug}`) })),
    ...listHelpArticles().map((a) => ({ url: url(`/help/${a.slug}`) })),
  ];
}
