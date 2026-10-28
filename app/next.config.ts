import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// R1 (5c): the private feature plugs in through one alias. Without src/private the core gets the empty registry.
const ext = existsSync("./src/private/registry.ts") ? "./src/private/registry.ts" : "./src/lib/extensions-none.ts";

// The console is never meant to sit inside another site's frame, and it serves nothing that should be sniffed.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  // Watchbell 1.2.1 (audit hardening list 3): no camera, microphone, location, payment or USB for any page, and a
  // browsing context of its own (Google Drive's OAuth is a full-page redirect, never a popup).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// Kantor Virtual (owner 14 Oct, private edition only): the office HTML is framed by the console itself (/office and the
// top bar's drawer), so it alone may sit in a SAME-ORIGIN frame, and only when the file is there (the open source edition
// has none and frames nothing). Listed after the catch-all: for the same key the last match wins (Next headers docs).
// It holds no data; it fetches /api/office/state, which needs the owner's session. The path is shared with the CSP
// (src/lib/security/static-html.ts).
const sameOriginFrame = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];
// Same path as OFFICE_FRAME_PATH in src/lib/security/static-html.ts (kept literal: the export tests load this file with plain
// Node, which can't resolve an extensionless TypeScript import; src/lib/security/static-html-config.test.ts checks they match).
const OFFICE_FRAME_PATH = "/office/kantor-virtual.html";
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
  poweredByHeader: false, // 1.2.1: no X-Powered-By: Next.js
  // PGlite finds its .wasm and .data files with new URL("./x", import.meta.url). Bundled, Turbopack swaps that for a
  // URL-like object without a protocol, which fs.readFile refuses on Vercel ("Received an instance of URL"; the demo
  // failed every sign-in with it). Loaded by Node from node_modules it gets a real file: URL, and output tracing keeps
  // the files next to it. Not in the npm package's standalone build: there the external becomes a symlink in
  // .next/node_modules, which a package can't carry, and the bundled PGlite works as it did up to 1.2.4.
  ...(standalone ? {} : { serverExternalPackages: ["@electric-sql/pglite"] }),
  // The PGlite migrator reads every .sql its journal lists, from a runtime path tracing can't follow, so a Vercel build
  // (the demo) shipped only meta/_journal.json and every sign-in failed with "No file …0000_….sql found". A few KB of SQL.
  // demo-snapshot/ (about 5 MB) exists only in a demo build: the migrated database src/lib/demo/template.ts loads.
  outputFileTracingIncludes: { "/**": ["./drizzle-selfhost/**/*", "./demo-snapshot/**/*"] },
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
