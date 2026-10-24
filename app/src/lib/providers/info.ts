import { PROVIDER_LINKS, type ProviderLink } from "./links";

export const PROVIDERS = ["vercel", "supabase", "neon", "firebase", "turso", "upstash", "cloudflare", "github", "github_write"] as const;
export type Provider = (typeof PROVIDERS)[number];

// createUrl, needs, guide and checked come from links.ts (1.2: one data file for the links, checked every release).
export const PROVIDER_INFO: Record<Provider, ProviderLink & {
  name: string;
  icon: "triangle" | "bolt" | "database" | "flame" | "cloud" | "github";
  credentialKind: string;
  accessNote: string;
  multiAccount: boolean;
  note: string;
  json?: boolean;
}> = {
  vercel: {
    ...PROVIDER_LINKS.vercel,
    name: "Vercel", icon: "triangle", credentialKind: "Access token",
    accessNote: "Full account (no read-only option)", multiAccount: false,
    note: "One account. Tokens can't be read-only, so actions always ask for confirmation.",
  },
  supabase: {
    ...PROVIDER_LINKS.supabase,
    name: "Supabase", icon: "bolt", credentialKind: "Scoped access token",
    accessNote: "Projects, health, analytics, organization and database read", multiAccount: true,
    note: "Each account gets 2 free active projects. Use scoped tokens: read-only, plus project admin if you want pause and restore.",
  },
  neon: {
    ...PROVIDER_LINKS.neon,
    name: "Neon", icon: "database", credentialKind: "API key",
    accessNote: "All projects (no read-only option)", multiAccount: true,
    note: "No read-only keys exist, so keys stay on the server.",
  },
  firebase: {
    ...PROVIDER_LINKS.firebase,
    name: "Firebase", icon: "flame", credentialKind: "Service account JSON",
    accessNote: "firebase.viewer, datastore.viewer, monitoring.viewer, firebaseauth.viewer", multiAccount: true, json: true,
    note: "One service account per Google account, with viewer roles only.",
  },
  // Stage 8 (checked 16 Oct 2026, docs.turso.tech/api-reference): Turso has no read-only platform token.
  turso: {
    ...PROVIDER_LINKS.turso,
    name: "Turso", icon: "database", credentialKind: "Platform API token",
    accessNote: "One organization: databases and usage (no read-only option)", multiAccount: true,
    note: "Lists databases and reads this month's rows read and written and storage against the free plan. Keys stay on the server.",
  },
  // Stage 8 (checked 16 Oct 2026, upstash.com/docs/devops/developer-api): Basic auth, email + Developer API key.
  upstash: {
    ...PROVIDER_LINKS.upstash,
    name: "Upstash", icon: "bolt", credentialKind: "Developer API key",
    accessNote: "Read-only Developer API key: Redis databases and stats", multiAccount: true,
    note: "Redis databases with their region, commands this month and data size against the free plan. QStash is budgeted in Settings.",
  },
  cloudflare: {
    ...PROVIDER_LINKS.cloudflare,
    name: "Cloudflare", icon: "cloud", credentialKind: "API token",
    accessNote: "Zone, DNS, SSL and Certificates read",
    multiAccount: true,
    note: "A read-only API token is enough to watch. Add DNS Edit only to change records from the console. Domain expiry comes from RDAP, so Registrar access isn't needed.",
  },
  // Stage 7 (owner's TODO, 13 Oct): read-only. Links apps to their repositories and reads GitHub Actions status.
  github: {
    ...PROVIDER_LINKS.github,
    name: "GitHub", icon: "github", credentialKind: "Fine-grained token",
    accessNote: "Metadata, Contents and Actions read", multiAccount: false,
    note: "A read-only fine-grained token. Sync lists your repositories; apps are linked to theirs, and their GitHub Actions status shows on the app page.",
  },
  // Stage 9 slice 5 (owner 16 Oct): a SEPARATE token, only for the office's approved "Open package update PR" (a new
  // branch and a pull request that bumps vulnerable packages). Never used to read, never pushes to the default branch.
  github_write: {
    ...PROVIDER_LINKS.github_write,
    name: "GitHub (PR write)", icon: "github", credentialKind: "Fine-grained token",
    accessNote: "Contents and Pull requests read and write, Commit statuses read, chosen repositories", multiAccount: false,
    note: "Optional. Opens pull requests that update vulnerable packages (when you approve one, or by itself with Automatic security fixes) and, with automatic fixes and auto-rollback on, squash-merges Watchbell's own PRs once CI, the Vercel preview and its smoke test pass. It never pushes to the default branch directly.",
  },
};
