export const PROVIDERS = ["vercel", "supabase", "neon", "firebase", "turso", "upstash", "cloudflare", "github", "github_write"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_INFO: Record<Provider, {
  name: string;
  icon: "triangle" | "bolt" | "database" | "flame" | "cloud" | "github";
  credentialKind: string;
  createUrl: string;
  needs: string[];
  accessNote: string;
  multiAccount: boolean;
  note: string;
  json?: boolean;
}> = {
  vercel: {
    name: "Vercel", icon: "triangle", credentialKind: "Access token", createUrl: "https://vercel.com/account/settings/tokens",
    needs: ["Scope: your account", "An expiry date. The console warns you 14 days before it ends."],
    accessNote: "Full account (no read-only option)", multiAccount: false,
    note: "One account. Tokens can't be read-only, so actions always ask for confirmation.",
  },
  supabase: {
    name: "Supabase", icon: "bolt", credentialKind: "Scoped access token", createUrl: "https://supabase.com/dashboard/account/tokens",
    needs: [
      "Projects read: status, region, Postgres version",
      "Project admin read: service health",
      "Analytics usage read: last API traffic and auto-pause risk",
      "Organization admin read: free plan, for the free-slot count",
      "Database read: database size, once a day (checked at the first daily read, because testing it would query your database)",
      "Project admin write, only if you want pause and restore (stage 6)",
    ],
    accessNote: "Projects, health, analytics, organization and database read", multiAccount: true,
    note: "Each account gets 2 free active projects. Use scoped tokens: read-only, plus project admin if you want pause and restore.",
  },
  neon: {
    name: "Neon", icon: "database", credentialKind: "API key", createUrl: "https://console.neon.tech/app/settings/api-keys",
    needs: ["A personal or project API key. Neon has no read-only keys."],
    accessNote: "All projects (no read-only option)", multiAccount: true,
    note: "No read-only keys exist, so keys stay on the server.",
  },
  firebase: {
    name: "Firebase", icon: "flame", credentialKind: "Service account JSON", createUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    needs: ["Roles on each project: firebase.viewer, datastore.viewer, monitoring.viewer, firebaseauth.viewer", "Turn on the Cloud Monitoring API in the project for reads, writes, and deletes today"],
    accessNote: "firebase.viewer, datastore.viewer, monitoring.viewer, firebaseauth.viewer", multiAccount: true, json: true,
    note: "One service account per Google account, with viewer roles only.",
  },
  // Stage 8 (checked 16 Oct 2026, docs.turso.tech/api-reference): Turso has no read-only platform token.
  turso: {
    name: "Turso", icon: "database", credentialKind: "Platform API token", createUrl: "https://app.turso.tech/account/api-tokens",
    needs: [
      "A platform API token limited to one organization (turso auth api-tokens mint watchbell --org <your-org>)",
      "Turso has no read-only platform tokens; the console only lists databases and reads usage",
      "Not a database token: database and group tokens can't list anything",
    ],
    accessNote: "One organization: databases and usage (no read-only option)", multiAccount: true,
    note: "Lists databases and reads this month's rows read and written and storage against the free plan. Keys stay on the server.",
  },
  // Stage 8 (checked 16 Oct 2026, upstash.com/docs/devops/developer-api): Basic auth, email + Developer API key.
  upstash: {
    name: "Upstash", icon: "bolt", credentialKind: "Developer API key", createUrl: "https://console.upstash.com/account/api",
    needs: [
      "A Developer API key created as Read Only (Account → Management API)",
      "Paste it as your-email:API_KEY (Upstash signs API calls with the account email and the key)",
      "Native Upstash accounts only: a database made through the Vercel integration can't be read this way",
    ],
    accessNote: "Read-only Developer API key: Redis databases and stats", multiAccount: true,
    note: "Redis databases with their region, commands this month and data size against the free plan. QStash is budgeted in Settings.",
  },
  cloudflare: {
    name: "Cloudflare", icon: "cloud", credentialKind: "API token", createUrl: "https://dash.cloudflare.com/profile/api-tokens",
    needs: [
      "Zone: Read, DNS: Read, SSL and Certificates: Read",
      "Zone Settings: Read, to show each zone's SSL/TLS mode (optional)",
      "Zone → DNS → Edit, only if the owner wants to edit records from the DNS records page (never create or delete)",
      "Account → D1 → Read, to watch Cloudflare D1 databases (size and tables); add Account → Account Analytics → Read for their rows read and written (optional)",
      "Not needed: Registrar (domain expiry comes from RDAP)",
    ],
    accessNote: "Zone, DNS, SSL and Certificates read",
    multiAccount: true,
    note: "A read-only API token is enough to watch. Add DNS Edit only to change records from the console. Domain expiry comes from RDAP, so Registrar access isn't needed.",
  },
  // Stage 7 (owner's TODO, 13 Oct): read-only. Links apps to their repositories and reads GitHub Actions status.
  github: {
    name: "GitHub", icon: "github", credentialKind: "Fine-grained token", createUrl: "https://github.com/settings/personal-access-tokens/new",
    needs: [
      "A fine-grained token (it starts with github_pat_); classic tokens can't be limited to read-only",
      "Repository access: all repositories, or only the ones your apps deploy from",
      "Repository permissions, each Read-only: Metadata, Contents, Actions. Nothing else",
      "An expiry date. The console warns you 14 days before it ends.",
    ],
    accessNote: "Metadata, Contents and Actions read", multiAccount: false,
    note: "A read-only fine-grained token. Sync lists your repositories; apps are linked to theirs, and their GitHub Actions status shows on the app page.",
  },
  // Stage 9 slice 5 (owner 16 Oct): a SEPARATE token, only for the office's approved "Open package update PR" (a new
  // branch and a pull request that bumps vulnerable packages). Never used to read, never pushes to the default branch.
  github_write: {
    name: "GitHub (PR write)", icon: "github", credentialKind: "Fine-grained token", createUrl: "https://github.com/settings/personal-access-tokens/new",
    needs: [
      "A separate fine-grained token (it starts with github_pat_), not the read-only one above",
      "Repository access: Only select repositories, the ones you want update PRs for",
      "Repository permissions: Contents: Read and write, Pull requests: Read and write, Commit statuses: Read (for automatic merges). Nothing else (Metadata read is added by GitHub)",
      "An expiry date. The console warns you 14 days before it ends.",
    ],
    accessNote: "Contents and Pull requests read and write, Commit statuses read, chosen repositories", multiAccount: false,
    note: "Optional. Opens pull requests that update vulnerable packages (when you approve one, or by itself with Automatic security fixes) and, with automatic fixes and auto-rollback on, squash-merges Watchbell's own PRs once CI, the Vercel preview and its smoke test pass. It never pushes to the default branch directly.",
  },
};
