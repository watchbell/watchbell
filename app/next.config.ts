import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// R1 (5c): the private feature plugs in through one alias. Without src/private the core gets the empty registry.
const ext = existsSync("./src/private/registry.ts") ? "./src/private/registry.ts" : "./src/lib/extensions-none.ts";

// The console is never meant to sit inside another site's frame, and it serves nothing that should be sniffed.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

// Kantor Virtual (owner 14 Oct, private edition only): the office HTML is framed by the console itself (/office and the
// top bar's drawer), so it alone may sit in a SAME-ORIGIN frame, and only when the file is there (the open source edition
// has none and frames nothing). Listed after the catch-all: for the same key the last match wins (Next headers docs).
// It holds no data; it fetches /api/office/state, which needs the owner's session.
const OFFICE_FRAME_PATH = "/office/kantor-virtual.html";
const sameOriginFrame = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
];
const officeFrame = existsSync(`./public${OFFICE_FRAME_PATH}`) ? [{ source: OFFICE_FRAME_PATH, headers: sameOriginFrame }] : [];

// The npm package (scripts/export/pack.mjs, from the public export only) builds with WATCHBELL_STANDALONE=1: Next's
// standalone server (.next/standalone with its own trimmed node_modules), so `npm i -g watchbell` never runs a build.
// Traced from this folder: an export can sit below a folder with its own lockfile, which Next would otherwise take as
// the root. The ISR cache stays in memory (isrFlushToDisk off), so a revalidated public status page is never written into
// the installed package (the global npm folder may not even be writable). Unset (Vercel, the installers, next dev) the
// config is exactly what it was before.
const standalone = process.env.WATCHBELL_STANDALONE === "1";
const appRoot = path.resolve(/*turbopackIgnore: true*/ ".");

const nextConfig: NextConfig = {
  ...(standalone ? { output: "standalone" as const, outputFileTracingRoot: appRoot, experimental: { isrFlushToDisk: false } } : {}),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, ...officeFrame];
  },
  turbopack: {
    ...(standalone ? { root: appRoot } : {}),
    resolveAlias: { "@ext/registry": ext },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
