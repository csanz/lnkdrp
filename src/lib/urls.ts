/**
 * URL helpers shared by client components.
 *
 * Keep these helpers deterministic and safe to call in both server/client
 * contexts (avoid directly touching `window` unless guarded).
 */

/**
 * Resolve the public site base URL.
 *
 * Priority:
 * - NEXT_PUBLIC_SITE_URL (recommended)
 * - window.location.origin (in the browser)
 * - empty string (server without config)
 */
export function getPublicSiteBase(): string {
  const env = (process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (env) return env;

  // Local dev fallback: email flows often need an absolute URL even when
  // `NEXT_PUBLIC_SITE_URL` isn't configured.
  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3001";
  }

  if (typeof window !== "undefined") {
    const origin = (window.location?.origin || "").trim();
    if (origin) return origin;
  }

  return "";
}

/**
 * Build a public share URL for a shareId.
 *
 * Returns an empty string when we cannot build a stable absolute URL.
 */
export function buildPublicShareUrl(shareId: string | null): string {
  if (!shareId) return "";

  // Defensive normalization:
  // Some older/local data may contain a leading delimiter (e.g. "|<id>").
  // The canonical shareId is a URL-safe slug; strip only leading pipes.
  const normalized = shareId.trim().replace(/^\|+/, "");
  if (!normalized) return "";

  const base = getPublicSiteBase();
  if (!base) return "";

  try {
    return new URL(`/s/${normalized}`, base).toString();
  } catch {
    return "";
  }
}

/**
 * Build a public request-upload URL for a request token.
 *
 * Returns an empty string when we cannot build a stable absolute URL.
 */
export function buildPublicRequestUrl(uploadToken: string | null): string {
  const token = typeof uploadToken === "string" ? uploadToken.trim() : "";
  if (!token) return "";
  const base = getPublicSiteBase();
  if (!base) return "";
  try {
    return new URL(`/request/${encodeURIComponent(token)}`, base).toString();
  } catch {
    return "";
  }
}

/**
 * Build a public request-view URL for a request view token.
 *
 * Returns an empty string when we cannot build a stable absolute URL.
 */
export function buildPublicRequestViewUrl(viewToken: string | null): string {
  const token = typeof viewToken === "string" ? viewToken.trim() : "";
  if (!token) return "";
  const base = getPublicSiteBase();
  if (!base) return "";
  try {
    return new URL(`/request-view/${encodeURIComponent(token)}`, base).toString();
  } catch {
    return "";
  }
}

/**
 * Build a public doc replacement-upload URL for a replacement token.
 *
 * Returns an empty string when we cannot build a stable absolute URL.
 */
export function buildPublicReplaceUrl(replaceToken: string | null): string {
  const token = typeof replaceToken === "string" ? replaceToken.trim() : "";
  if (!token) return "";
  const base = getPublicSiteBase();
  if (!base) return "";
  try {
    return new URL(`/doc/update/${encodeURIComponent(token)}`, base).toString();
  } catch {
    return "";
  }
}





