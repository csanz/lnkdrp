/**
 * `robots.txt`, which this app did not have at all.
 *
 * Until now nothing told a crawler to stay off the recipient-facing routes, and nothing on those
 * pages said "do not index" either (see `buildShareMetadata`). A share URL is a secret only for as
 * long as nobody publishes it, and they leak constantly in ordinary use: a recipient forwards the
 * mail to a webmail account whose provider prefetches links, pastes it into a public Slack or
 * Discord channel that unfurls and archives it, or opens it in a browser with a "send URLs to
 * improve search" toolbar. Any one of those hands a crawler the URL, and with no rule here the
 * next step was a cached copy of somebody's deck — title, AI summary and cover image — sitting in
 * a search index, reachable by people the sender never sent a link to.
 *
 * What each half of the fix buys, because they are not the same thing and neither is sufficient:
 *
 * - **This file stops the fetch.** A crawler that obeys `robots.txt` never requests the page, so
 *   the document is never rendered for it. That also keeps bot traffic out of the sender's view
 *   analytics, which is the difference between "opened by 3 recipients" and a number padded by
 *   Googlebot. It is advisory: a crawler that ignores it, or one reading a host that serves its
 *   own `robots.txt`, is unaffected.
 * - **`noindex` stops the indexing.** `buildShareMetadata` emits `robots: { index: false }` on
 *   every share page, which is the real control for anything that does fetch the page.
 *
 * The known gap in combining them: a URL disallowed here is never fetched, so the `noindex` on it
 * is never read, and a search engine that learned the URL from a link elsewhere may still list it
 * URL-only. That is accepted — what must not escape is the document's title, summary and preview
 * image, and none of that is fetched. The alternative (allow the crawl so the `noindex` is seen)
 * would mean serving the document to every bot that asks, which is worse.
 *
 * Only paths that serve recipient content without a login are listed. The signed-in app
 * (`/dashboard`, `/preferences`, …) is deliberately absent: its auth gate is the control, and
 * enumerating it here would only publish the route list.
 *
 * Everything not listed stays crawlable — the marketing pages (`/`, `/about`, `/pricing`,
 * `/privacy`, `/tos`) are the reason this file allows by default rather than disallowing `/`.
 */
import type { MetadataRoute } from "next";

/**
 * Prefix-matched paths a crawler must not request.
 *
 * Each one is addressed by a capability token in the URL, so fetching it is the same thing as
 * being a recipient. Keep this in step with the public route segments under `src/app`.
 */
const RECIPIENT_PATHS = [
  "/s/", // share viewer — one link, one document
  "/p/", // project ("data room") viewer, and `/p/:shareId/:docId` inside it
  "/share/", // legacy share alias; it redirects into `/s/`, so a crawler would follow it there
  "/r/", // request upload link
  "/request/", // request upload link (preferred alias of `/r/`)
  "/request-view/", // view-only request repo
  "/replace/", // capability link to upload a new version of a document
  "/doc/", // `/doc/update/:code`, the same capability under its own route
  "/download/", // approved download claim
  "/api/", // no crawler has business here, and some of it serves document bytes
];

/**
 * Build the `robots.txt` Next serves at `/robots.txt`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: RECIPIENT_PATHS,
      },
    ],
  };
}
