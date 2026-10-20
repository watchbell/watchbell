// Made-up names for the demo data. None of them is the owner's or a real customer's project.

// Every host the demo shows (sites, deployment urls, and the domains of later seeds) is under the reserved `.example`
// TLD (RFC 2606), which never resolves, so no seeded name can be someone's real site. Repositories sit under a made-up
// organisation for the same reason.
export const DEMO_TLD = "example";
export const demoHost = (label: string): string => `${label}.${DEMO_TLD}`;
export const REPO_ORG = "example-org";

// Vercel-style project names; a seed picks 5-8 of them.
export const APP_NAMES = [
  "acme-shop", "orbit-blog", "nimbus-docs", "pixel-forge", "harbor-api", "lumen-portal", "quartz-admin", "tidal-landing",
  "ember-status", "cobalt-store", "willow-wiki", "atlas-dash", "sprout-crm", "comet-links", "fable-notes", "maple-events",
] as const;

// The made-up Vercel team the apps belong to.
export const TEAMS = [
  { name: "Juniper Labs", slug: "juniper-labs" },
  { name: "Kestrel Works", slug: "kestrel-works" },
  { name: "Brightfield Studio", slug: "brightfield-studio" },
  { name: "Saltmarsh Digital", slug: "saltmarsh-digital" },
] as const;

// Vercel's framework slugs.
export const FRAMEWORKS = ["nextjs", "nextjs", "nextjs", "vite", "astro", "sveltekit", "remix"] as const;

export const REGIONS = ["sin1", "iad1", "fra1", "hnd1", "sfo1"] as const;

export const PREVIEW_BRANCHES = [
  "feat/checkout-v2", "feat/dark-mode", "fix/login-redirect", "feat/search", "chore/deps", "fix/image-sizes", "feat/newsletter", "fix/cache-headers",
] as const;

export const COMMIT_MESSAGES = [
  "Fix cart total rounding", "Add dark mode toggle", "Update dependencies", "Speed up the product grid", "Fix login redirect loop",
  "Add sitemap", "Tidy the footer links", "Cache the pricing page", "Add newsletter signup", "Fix image sizes on mobile",
  "Bump Next.js", "Add search to the docs", "Handle empty states", "Retry failed webhooks", "Move env checks to startup",
  "Shorten the onboarding copy", "Add health endpoint", "Fix timezone in the event list", "Split the dashboard bundle", "Add RSS feed",
] as const;

// What the one failed build says (shown as its commit; the build log isn't part of the demo).
export const FAILED_COMMIT = "Refactor the checkout form";

// Database names per kind; a seed picks one of each.
export const DB_NAMES = {
  supabase_project: ["shop-prod", "portal-main", "crm-core", "store-db"],
  neon_project: ["analytics", "reporting", "billing-ledger", "metrics-pg"],
  firestore: ["notes-app", "mobile-sync", "feedback-inbox", "event-chat"],
  turso_database: ["edge-cache", "geo-lookup", "docs-search", "flags"],
  upstash_redis: ["sessions", "rate-limits", "queue-cache", "page-cache"],
  d1_database: ["events-log", "link-clicks", "form-entries", "audit-trail"],
} as const;

// Made-up Cloudflare zones (always under .example); a seed picks two.
export const ZONE_LABELS = ["acme-studio", "orbit-labs", "nimbus-works", "pixel-harbor", "tidal-digital", "ember-co"] as const;

// Runtime-log lines for the Logs page (warning / error / fatal), made up.
export const LOG_LINES = [
  { level: "error", method: "POST", path: "/api/checkout", status: 500, message: "TypeError: Cannot read properties of undefined (reading 'price')" },
  { level: "warning", method: "GET", path: "/products", status: 200, message: "Slow query: products list took 1840 ms" },
  { level: "error", method: "GET", path: "/api/search", status: 504, message: "Task timed out after 10.02 seconds" },
  { level: "warning", method: "GET", path: "/", status: 200, message: "Image optimization fell back to the original file (unsupported format)" },
  { level: "error", method: "POST", path: "/api/webhooks/payments", status: 401, message: "Webhook signature didn't match" },
  { level: "fatal", method: "GET", path: "/api/report", status: 500, message: "Error: connect ECONNREFUSED (database connection pool exhausted)" },
  { level: "warning", method: "GET", path: "/blog/[slug]", status: 404, message: "Post not found for slug \"spring-sale-2025\"" },
  { level: "error", method: "PUT", path: "/api/profile", status: 422, message: "ZodError: email must be a valid email" },
] as const;
