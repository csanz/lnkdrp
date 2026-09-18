/**
 * The link card a recipient's chat app draws when a share URL is pasted.
 *
 * Extracted from `/s/[shareId]/page.tsx`, unchanged, because `/p/:shareId` and `/p/:shareId/:docId`
 * need exactly the same card and exactly the same suppression rule, and a second copy of the
 * origin/OG-image reasoning would have drifted the first time one of the two was touched.
 *
 * The suppression rule is the part worth stating once: a locked or refused link gets the **generic**
 * card. Pasting a password-protected data room's URL into a channel unfurls before anyone types
 * anything, so the title and first page would reach every member of that channel — the leak the
 * password exists to prevent. Callers decide that a link is locked or refused and simply pass no
 * `title`/`description`/`previewUrl`; this helper never resolves a link itself.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";

import { getMetadataBaseUrl } from "@/lib/urls";

/**
 * Build the page's `Metadata` from strings the caller has already decided are safe to publish.
 *
 * `previewUrl` may be absolute (`https://…`) or root-relative (`/…`); anything else falls back to
 * the site's default OG image, as does an absent one.
 */
export async function buildShareMetadata(input: {
  title: string;
  description: string;
  previewUrl?: string | null;
}): Promise<Metadata> {
  const title = input.title.trim() || "Shared document";
  const description = input.description.trim() || "Shared with LinkDrop.";

  // Prefer the request origin (correct for preview deployments / custom domains); a malformed
  // host header must not 500 the share page, so fall back to the configured site URL.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const metadataBase = (() => {
    if (host) {
      try {
        return new URL(`${proto}://${host}`);
      } catch {
        // fall through to configured site URL
      }
    }
    return getMetadataBaseUrl();
  })();

  const previewCandidate = typeof input.previewUrl === "string" && input.previewUrl ? input.previewUrl : null;
  const images: NonNullable<Metadata["openGraph"]>["images"] = (() => {
    if (previewCandidate) {
      if (/^https?:\/\//i.test(previewCandidate)) return [{ url: new URL(previewCandidate), alt: title }];
      if (previewCandidate.startsWith("/")) return [{ url: new URL(previewCandidate, metadataBase), alt: title }];
    }
    return [{ url: new URL("/images/og.png", metadataBase), width: 840, height: 491, alt: title }];
  })();

  return {
    title,
    description,
    metadataBase,
    twitter: { card: "summary_large_image", title, description, images },
    openGraph: { type: "website", title, description, images },
  };
}
