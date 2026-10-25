import path from "node:path";
import type { NextConfig } from "next";

// The public site (plan 7): a plain static export. `next build` writes every page to out/ as HTML, nothing runs on a
// server. The docs are read from ../public-edition/docs (private tree) or ../docs (public repo) at build time.
const siteRoot = path.resolve(/*turbopackIgnore: true*/ ".");

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Two root layouts ((en) at /, (id) at /id) need the global 404 page (app/global-not-found.tsx).
  experimental: { globalNotFound: true },
  // This folder has its own lockfile; the repository root above it is not a workspace.
  turbopack: { root: siteRoot },
};

export default nextConfig;
