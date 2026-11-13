import type { BuildFacts } from "./facts";
import { buildFiles } from "./templates";

// Watchbell 1.5 Build files in demo mode: made-up facts for a made-up app, so Generate shows real-looking files without
// reading anything. Pure.

const facts: BuildFacts = {
  kind: "nextjs", dir: ".", pm: "pnpm", node: 24, standalone: true, port: 3000, guessed: [],
  envNames: ["DATABASE_URL", "NEXT_PUBLIC_SITE_URL", "RESEND_API_KEY"],
  scripts: { build: true, start: true, lint: true, test: true, typecheck: "typecheck" },
};

export const DEMO_BUILD_FILES = {
  facts, repo: "acme/storefront", branch: "main",
  files: buildFiles(facts, { app: "storefront", version: null, repo: "acme/storefront", branch: "main" }),
};
