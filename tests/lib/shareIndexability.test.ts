/**
 * Share and data-room pages were indexable, and nothing said otherwise.
 *
 * The app shipped with no `robots.txt` and no robots directive on any page, while
 * `buildShareMetadata` published the document's title, its AI summary and a cover image into the
 * `<head>` of every `/s/:shareId` and `/p/:shareId` page. A share URL reaches crawlers without
 * anyone publishing it — webmail prefetching, a public channel that unfurls and archives links, a
 * browser toolbar that reports visited URLs — so a deck meant for one recipient could end up
 * findable by title in a search index.
 *
 * The fix is two controls, and these tests pin both because either alone is a hole:
 * - `src/app/robots.ts` disallows the recipient-facing paths, which stops a well-behaved crawler
 *   from fetching the page at all (and keeps bot hits out of the sender's view analytics).
 * - `robots: { index: false, follow: false }` in the metadata is what holds for a crawler that
 *   fetched the page anyway.
 *
 * The third assertion is the one that keeps the fix honest: the OG/Twitter card must survive. An
 * unfurl is a deliberate forward by someone who already holds the link, and "not in a search
 * index" is not "no preview" — a future tightening to `nosnippet`/`noimageindex` or a stripped
 * `openGraph` would break the product feature this page exists for.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (n: string) => (n === "host" ? "app.lnkdrp.com" : null) })),
}));
vi.mock("@/lib/urls", () => ({ getMetadataBaseUrl: () => new URL("https://app.lnkdrp.com") }));

import robots from "@/app/robots";
import { buildShareMetadata } from "@/lib/share/shareMetadata";

/** The routes that serve a recipient their document, addressed by a capability token in the URL. */
const RECIPIENT_PATHS = [
  "/s/",
  "/p/",
  "/share/",
  "/r/",
  "/request/",
  "/request-view/",
  "/replace/",
  "/doc/",
  "/download/",
  "/api/",
];

describe("robots.txt keeps crawlers off recipient content", () => {
  const rule = (() => {
    const rules = robots().rules;
    const list = Array.isArray(rules) ? rules : [rules];
    const wildcard = list.find((r) => r.userAgent === "*");
    expect(wildcard, "no `User-agent: *` rule").toBeDefined();
    return wildcard!;
  })();

  const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow].filter(Boolean);

  test.each(RECIPIENT_PATHS)("%s is disallowed", (path) => {
    expect(disallow).toContain(path);
  });

  test("the marketing site is still crawlable", () => {
    // The whole reason this file allows by default: disallowing `/` would have quietly delisted
    // the pages that are supposed to be found.
    const allow = Array.isArray(rule.allow) ? rule.allow : [rule.allow].filter(Boolean);
    expect(allow).toContain("/");
    for (const marketing of ["/", "/about", "/pricing", "/privacy", "/tos"]) {
      expect(disallow).not.toContain(marketing);
    }
  });
});

describe("share metadata says noindex, and still draws a card", () => {
  test("every share page carries index:false, follow:false", async () => {
    const meta = await buildShareMetadata({
      title: "Series B deck",
      description: "Our Series B raise",
      previewUrl: "/s/sh_abc123/og.png",
    });

    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });

  test("a locked link's generic card is noindex too", async () => {
    // Callers signal "locked or refused" by passing nothing; that page is still a page a crawler
    // can reach, so the directive must not depend on having a title.
    const meta = await buildShareMetadata({ title: "", description: "" });
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });

  test("the chat preview survives the noindex", async () => {
    const meta = await buildShareMetadata({
      title: "Series B deck",
      description: "Our Series B raise",
      previewUrl: "/s/sh_abc123/og.png",
    });

    expect(meta.openGraph?.title).toBe("Series B deck");
    expect(meta.openGraph?.description).toBe("Our Series B raise");
    const images = meta.openGraph?.images;
    const first = Array.isArray(images) ? images[0] : images;
    expect(String((first as { url?: unknown })?.url)).toBe("https://app.lnkdrp.com/s/sh_abc123/og.png");

    const twitter = meta.twitter as { card?: string; title?: string } | undefined;
    expect(twitter?.card).toBe("summary_large_image");
    expect(twitter?.title).toBe("Series B deck");
  });
});
