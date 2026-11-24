import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    // Next.js agent upgrades follow security releases only (set by `next upgrade --agent=security`).
    agentUpgrade: "security",
  },
};

export default nextConfig;
