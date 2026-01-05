import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Native / binary deps must remain external for Turbopack builds.
   * (Otherwise Turbopack tries to place native assets into ESM chunks.)
   */
  serverExternalPackages: ["@napi-rs/canvas"],
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
};

export default nextConfig;
