import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Expense pages moved to the top level (owner, 26 Nov 2026): the old /expenses/<section> URLs (bookmarks, history)
  // go to the canonical /<section> — query string kept. Only these five; nothing else under /expenses exists.
  async redirects() {
    return [{ source: "/expenses/:section(road-tax|insurance|fitness|fines|broker-charges)", destination: "/:section", permanent: true }]
  },
  experimental: {
    // Next.js agent upgrades follow security releases only (set by `next upgrade --agent=security`).
    agentUpgrade: "security",
  },
};

export default nextConfig;
