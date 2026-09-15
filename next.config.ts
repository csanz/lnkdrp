import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Native / binary deps must remain external for Turbopack builds.
   * (Otherwise Turbopack tries to place native assets into ESM chunks.)
   */
  // `pdfjs-dist` is loaded via a static `import("pdfjs-dist/legacy/build/pdf.mjs")` on the server;
  // keeping it external lets Node resolve its fake worker / asset files from node_modules.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  /**
   * Ship pdf.js's data files with the two functions that render PDF pages.
   *
   * `resolvePdfJsAssetUrls` in `src/lib/pdf/renderPage.ts` hands pdf.js `file://` URLs for
   * `standard_fonts`, `cmaps` and `wasm`, built with `path.join` and checked with `fs.existsSync`.
   * Nothing ever imports them, so the build's file tracer has no reason to include them, and
   * `serverExternalPackages` keeps pdfjs out of the bundle as well. Locally this is invisible
   * because `node_modules` is right there; in a deployed function the directories are absent.
   *
   * The failure is quiet and late, which is why it is worth 3MB: the resolver's `existsSync` returns
   * false, the options are dropped, and pdf.js renders without them — so a deck with an embedded
   * CJK or symbol font comes out with missing glyphs in its page images and its extracted text,
   * on the first production upload, with nothing in the logs. Verified against
   * `.next/server/app/api/uploads/[uploadId]/process/route.js.nft.json`: 645 files traced, 3 from
   * pdfjs-dist, none from these three directories.
   *
   * Keep this list in step with the routes that reach `renderPage`, currently the upload pipeline
   * and the compare rerun.
   */
  outputFileTracingIncludes: {
    "/api/uploads/[uploadId]/process": [
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/wasm/**",
    ],
    "/api/docs/[docId]/changes/[changeId]/rerun": [
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/wasm/**",
    ],
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
