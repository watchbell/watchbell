import type { Provider } from "./info";

// 1.2 (spec §7): where each provider's token is made and the smallest permissions it needs. The one data file the
// credential form reads ("Create one ↗" / "How to create one ↗" and "It needs"); PROVIDER_INFO takes these fields from
// here, so a link lives in one place. Free tiers and dashboards move: every entry is re-checked each release and its
// `checked` date moved on. `guide: true` marks a self-hosted tool, whose link is the official guide to creating a token
// (the form then says "How to create one") rather than a token page on a shared dashboard.
export type ProviderLink = { createUrl: string; guide?: true; needs: string[]; checked: string };

export const PROVIDER_LINKS: Record<Provider, ProviderLink> = {
  vercel: {
    createUrl: "https://vercel.com/account/settings/tokens",
    needs: ["Scope: your account", "An expiry date. The console warns you 14 days before it ends."],
    checked: "2026-10-21",
  },
  supabase: {
    createUrl: "https://supabase.com/dashboard/account/tokens",
    needs: [
      "Projects read: status, region, Postgres version",
      "Project admin read: service health",
      "Analytics usage read: last API traffic and auto-pause risk",
      "Organization admin read: free plan, for the free-slot count",
      "Database read: database size, once a day (checked at the first daily read, because testing it would query your database)",
      "Project admin write, only if you want pause and restore (stage 6)",
    ],
    checked: "2026-10-21",
  },
  neon: {
    createUrl: "https://console.neon.tech/app/settings/api-keys",
    needs: ["A personal or project API key. Neon has no read-only keys."],
    checked: "2026-10-21",
  },
  firebase: {
    createUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    needs: ["Roles on each project: firebase.viewer, datastore.viewer, monitoring.viewer, firebaseauth.viewer", "Turn on the Cloud Monitoring API in the project for reads, writes, and deletes today"],
    checked: "2026-10-21",
  },
  // Stage 8 (docs.turso.tech/api-reference): Turso has no read-only platform token.
  turso: {
    createUrl: "https://app.turso.tech/account/api-tokens",
    needs: [
      "A platform API token limited to one organization (turso auth api-tokens mint watchbell --org <your-org>)",
      "Turso has no read-only platform tokens; the console only lists databases and reads usage",
      "Not a database token: database and group tokens can't list anything",
    ],
    checked: "2026-10-21",
  },
  // Stage 8 (upstash.com/docs/devops/developer-api): Basic auth, email + Developer API key.
  upstash: {
    createUrl: "https://console.upstash.com/account/api",
    needs: [
      "A Developer API key created as Read Only (Account → Management API)",
      "Paste it as your-email:API_KEY (Upstash signs API calls with the account email and the key)",
      "Native Upstash accounts only: a database made through the Vercel integration can't be read this way",
    ],
    checked: "2026-10-21",
  },
  cloudflare: {
    createUrl: "https://dash.cloudflare.com/profile/api-tokens",
    needs: [
      "Zone: Read, DNS: Read, SSL and Certificates: Read",
      "Zone Settings: Read, to show each zone's SSL/TLS mode (optional)",
      "Zone → DNS → Edit, only if the owner wants to edit records from the DNS records page (never create or delete)",
      "Account → D1 → Read, to watch Cloudflare D1 databases (size and tables); add Account → Account Analytics → Read for their rows read and written (optional)",
      "Not needed: Registrar (domain expiry comes from RDAP)",
    ],
    checked: "2026-10-21",
  },
  github: {
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    needs: [
      "A fine-grained token (it starts with github_pat_); classic tokens can't be limited to read-only",
      "Repository access: all repositories, or only the ones your apps deploy from",
      "Repository permissions, each Read-only: Metadata, Contents, Actions. Nothing else",
      "An expiry date. The console warns you 14 days before it ends.",
    ],
    checked: "2026-10-21",
  },
  github_write: {
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    needs: [
      "A separate fine-grained token (it starts with github_pat_), not the read-only one above",
      "Repository access: Only select repositories, the ones you want update PRs for",
      "Repository permissions: Contents: Read and write, Pull requests: Read and write, Commit statuses: Read (for automatic merges). Nothing else (Metadata read is added by GitHub)",
      "An expiry date. The console warns you 14 days before it ends.",
    ],
    checked: "2026-10-21",
  },
};
