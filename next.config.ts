import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Native / binary deps must remain external for Turbopack builds.
   * (Otherwise Turbopack tries to place native assets into ESM chunks.)
   */
  serverExternalPackages: ["@napi-rs/canvas"],
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
