import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Native / binary deps must remain external for Turbopack builds.
   * (Otherwise Turbopack tries to place native assets into ESM chunks.)
   */
  serverExternalPackages: ["@napi-rs/canvas"],
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
