import type { NextConfig } from "next";

/**
 * pdf.js's data files, which nothing imports.
 *
 * `resolvePdfJsAssetUrls` in `src/lib/pdf/renderPage.ts` hands pdf.js `file://` URLs for these
 * directories, built with `path.join` and probed with `fs.existsSync`. No import statement ever
 * names them, so the build's file tracer has no reason to include them, and `serverExternalPackages`
 * keeps pdfjs out of the bundle as well. Locally this is invisible because `node_modules` is right
 * there; in a deployed function the directories are simply absent.
 *
 * The failure is quiet and late, which is why it is worth ~2.5MB per function: `existsSync` returns
 * false, the options are dropped, and pdf.js renders anyway — so a deck with an embedded CJK or
 * symbol font comes out with missing glyphs in its page images and its extracted text, on the first
 * production upload, with nothing in the logs.
 */
const PDFJS_DATA_FILES = [
  "./node_modules/pdfjs-dist/standard_fonts/**",
  "./node_modules/pdfjs-dist/cmaps/**",
  "./node_modules/pdfjs-dist/wasm/**",
];

const nextConfig: NextConfig = {
  /**
   * Native / binary deps must remain external for Turbopack builds.
   * (Otherwise Turbopack tries to place native assets into ESM chunks.)
   */
  // `pdfjs-dist` is loaded via a static `import("pdfjs-dist/legacy/build/pdf.mjs")` on the server;
  // keeping it external lets Node resolve its fake worker / asset files from node_modules.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  /**
   * Which functions get {@link PDFJS_DATA_FILES}, and why the keys are globs.
   *
   * The exact route paths (`/api/uploads/[uploadId]/process`) match nothing — a build with those
   * keys traced zero of the three directories, which is easy to mistake for the option not working.
   * Glob keys do match. They are kept as narrow as possible so the ~2.5MB lands only in the two
   * functions that render PDF pages; a broader `/api/**` put it in every API function.
   *
   * Verified against the trace output rather than assumed. After this change
   * `/api/uploads/[uploadId]/process` traces 16 font files, 169 cmaps and 7 wasm, the compare rerun
   * the same, and `/api/docs/[docId]/links` and `/api/health` none.
   *
   * Keep in step with the routes that reach `renderPage`: the upload pipeline and the compare rerun.
   */
  outputFileTracingIncludes: {
    "/api/uploads/*/process": PDFJS_DATA_FILES,
    "/api/docs/*/changes/*/rerun": PDFJS_DATA_FILES,
  },

  /**
   * Baseline security headers on every response Next serves (pages, route handlers, `public/`).
   *
   * - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` — SAMEORIGIN rather than DENY
   *   because the app frames itself: `/paperplane/index.html` on the marketing pages, and the
   *   PDF routes inside the doc page and the share viewer. `frame-ancestors` is the directive
   *   browsers actually honour; `X-Frame-Options` is kept for anything that predates it.
   *   Nothing here is meant to be embedded by another site, so third-party framing — and the
   *   clickjacking it enables on the share and download-approval flows — is refused.
   * - `X-Content-Type-Options: nosniff` — an uploaded PDF must never be sniffed into something
   *   the browser will execute. Every route that returns bytes sets its own `content-type`
   *   (the PDF routes fall back to `application/pdf`), so nothing depends on sniffing.
   * - `Referrer-Policy: strict-origin-when-cross-origin` — share URLs carry a secret token in
   *   the path, so a full referrer must never leave the origin.
   *
   * HSTS is deliberately absent: Vercel already sends `Strict-Transport-Security` for its own
   * domains, and setting it here with `includeSubDomains` would speak for hosts this app does
   * not serve (the realtime and MCP subdomains on Fly).
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // Disable all in-browser dev indicators (including the "Rendering/Compiling" HUD).
  devIndicators: false,
  /**
   * Reduce "recompiling on every navigation" in dev by keeping more entries warm.
   * This is especially helpful on slower / synced filesystems.
   */
  onDemandEntries: {
    // 1 hour
    maxInactiveAge: 60 * 60 * 1000,
    // Keep more routes in memory before evicting.
    pagesBufferLength: 10,
  },
  turbopack: {
    // Ensure Next picks *this* repo root even if other lockfiles exist.
    root: process.cwd(),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
    /**
     * Which `quality` values `next/image` is allowed to ask the optimiser for.
     *
     * Next 16 defaults this to `[75]` and silently serves 75 for anything not listed — no warning,
     * no error, just a `&q=75` in the URL. The homepage product shots pass `quality={90}` for a
     * reason (at 75 the compressor spends its budget on the large flat areas of a screenshot and
     * takes it out of the 11px labels, which is the only part anyone is trying to read), and that
     * prop had been doing nothing since the day it was written. Verified against the live page:
     * the request was `?url=/images/home/agents.png&w=1920&q=75`.
     *
     * Kept to the two values actually used, because every entry here is a size the optimiser may
     * be asked to generate and cache.
     */
    qualities: [75, 90],
  },
  /**
   * In dev, ignore noisy filesystem churn (sync tools / caches) that can cause
   * infinite "rebuilding" + full page reload loops.
   */
  webpack: (config, { dev }) => {
    if (!dev) return config;

    const existingIgnored = config.watchOptions?.ignored;
    const ignoredArrayRaw = Array.isArray(existingIgnored)
      ? existingIgnored
      : existingIgnored
        ? [existingIgnored]
        : [];
    // Webpack schema validation requires non-empty strings here.
    // Some environments (or upstream config) can provide `""`, which breaks `next dev --webpack`.
    const ignoredArray = ignoredArrayRaw.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );

    config.watchOptions = {
      ...(config.watchOptions ?? {}),
      ignored: [
        ...ignoredArray,
        "**/tmp/**",
        "**/.npm-cache/**",
        "**/.DS_Store",
        "**/.__mtime_ref",
      ],
    };

    return config;
  },
};

export default nextConfig;
