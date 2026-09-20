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
 * `previewUrl` must be **root-relative** (`/s/<shareId>/og.png`). Anything else — an absolute URL
 * above all — falls back to the site's default OG image, as does an absent one.
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
    // Root-relative only, on purpose. An absolute URL used to be published verbatim, and the one
    // thing callers had to hand was the document's stored preview: a public blob URL whose path is
    // `docs/<docId>/uploads/<uploadId>/preview.png`. That went straight into `og:image`, so anyone
    // forwarded a share link — or any bot that unfurled it into a channel — could read the
    // document id and upload id out of the page source, and those ids are exactly what every
    // `/api/docs/:docId` surface is addressed by. The blob is meant to reach recipients through
    // `/s/<shareId>/og.png`, which re-serves the bytes from our own origin and re-runs the
    // refusal/password checks on every fetch. Refusing absolute URLs here is what keeps that proxy
    // from being bypassed the next time someone reaches for the stored URL as a convenience.
    if (previewCandidate?.startsWith("/")) {
      // `//evil.example/x` is protocol-relative, not a path: it resolves off-origin.
      if (!previewCandidate.startsWith("//")) {
        return [{ url: new URL(previewCandidate, metadataBase), alt: title }];
      }
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
