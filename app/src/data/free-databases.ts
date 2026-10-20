// Spec §5 (src/data/free-databases.ts) and the mockup's FREE_DBS / NOT_FREE: hosted databases with a free plan, as
// read from each provider's official pricing page. "Unverified" = the page didn't say. Plain data; the Free databases
// page (/catalog) renders it. Stage 8 re-checked the providers the console watches on CHECKED_ON (CATALOG_SOURCES);
// the others keep FIRST_CHECKED_ON (their `checked` field).

export const CHECKED_ON = "16 Oct 2026";
export const FIRST_CHECKED_ON = "11 Oct 2026";

// The official pages read on CHECKED_ON for every free-plan number the console shows (catalog, budget, pages, alerts).
export const CATALOG_SOURCES: [string, string][] = [
  ["Vercel Hobby", "https://vercel.com/docs/functions/usage-and-pricing"],
  ["Vercel Web Analytics", "https://vercel.com/docs/analytics/limits-and-pricing"],
  ["Supabase Free", "https://supabase.com/pricing"],
  ["Neon Free", "https://neon.com/docs/introduction/plans"],
  ["Firebase Spark (Firestore)", "https://firebase.google.com/docs/firestore/quotas"],
  ["Cloudflare D1", "https://developers.cloudflare.com/d1/platform/limits/"],
  ["Cloudflare Workers", "https://developers.cloudflare.com/workers/platform/pricing/"],
  ["Upstash Redis", "https://upstash.com/docs/redis/overall/pricing"],
  ["Upstash QStash", "https://upstash.com/docs/qstash/overall/pricing"],
  ["Turso", "https://turso.tech/pricing"],
  ["cron-job.org", "https://cron-job.org/en/faq/"],
];

export type Adapter = "built" | "planned" | "none";

export type FreeDb = {
  name: string; type: string; limits: string; sleep: string; card: string; asia: string; drizzle: string;
  monitor: string; adapter: Adapter; pick: string; url: string;
  checked?: string; // when this row was last read against its page; absent = CHECKED_ON
};

export const FREE_DBS: FreeDb[] = [
  { name: "Supabase", type: "Postgres + auth, storage, realtime", limits: "500 MB per DB, 2 active projects per user (paused ones don't count), 5 GB egress + 5 GB cached egress, 1 GB files, 50k MAU", sleep: "Pauses after 7 days without activity", card: "No", asia: "Singapore, Tokyo, Seoul", drizzle: "Yes", monitor: "Status, health, API traffic, pause and restore", adapter: "built", pick: "Full backend", url: "https://supabase.com/pricing" },
  { name: "Neon", type: "Postgres (serverless)", limits: "1 GB per project (20 GB total), 100 CU-hours per project a month, 100 projects, 5 GB egress per project a month", sleep: "Scales to zero after 5 min, cold start on next query", card: "No", asia: "Singapore", drizzle: "Yes", monitor: "Compute state, CU-hours, size, wake", adapter: "built", pick: "Best Postgres for Vercel", url: "https://neon.com/pricing" },
  { name: "Firebase Firestore", type: "Document + realtime", limits: "1 GiB, 50k reads, 20k writes, 20k deletes a day (reset at midnight Pacific), 10 GiB egress a month", sleep: "Never sleeps, stops at the daily cap", card: "No", asia: "Jakarta, Singapore, Tokyo", drizzle: "No", monitor: "Health check, Auth users, daily ops (needs test)", adapter: "built", pick: "Realtime documents", url: "https://firebase.google.com/pricing" },
  { name: "Turso", type: "SQLite (libSQL)", limits: "100 DBs, 5 GB, 500M rows read and 10M rows written a month, 3 GB syncs", sleep: "No pausing documented", card: "No", asia: "Unverified (US and EU listed)", drizzle: "Yes", monitor: "Databases, rows read and written, storage (per organization)", adapter: "built", pick: "Most generous SQL", url: "https://turso.tech/pricing" },
  { name: "Upstash Redis", type: "Key-value", limits: "256 MB data (the card says 250 MB), 500k commands a month, 10 GB bandwidth, 10k commands/s; 1 free DB (its FAQ says 10)", sleep: "No pausing documented", card: "No", asia: "Unverified", drizzle: "n/a", monitor: "Databases, commands this month, data size, bandwidth", adapter: "built", pick: "Cache, rate limits, queues", url: "https://upstash.com/pricing/redis" },
  { name: "Cloudflare D1", type: "SQLite", limits: "10 DBs, 500 MB each, 5 GB per account, 5M rows read and 100k rows written a day", sleep: "Never sleeps, errors until 00:00 UTC at the cap", card: "No", asia: "Automatic placement", drizzle: "Only via HTTP, awkward from Vercel", monitor: "Size; rows read and written today (needs Account Analytics read)", adapter: "built", pick: "Apps on Cloudflare Workers", url: "https://developers.cloudflare.com/d1/platform/pricing/" },
  { name: "TiDB Cloud Starter", type: "MySQL-compatible", limits: "5 instances, 5 GiB rows + 5 GiB columnar, 50M request units a month each", sleep: "No pausing, rejects connections at the cap", card: "No", asia: "Unverified", drizzle: "Yes", monitor: "API unverified", adapter: "none", pick: "Best free MySQL", url: "https://www.pingcap.com/pricing/" , checked: FIRST_CHECKED_ON },
  { name: "MongoDB Atlas", type: "Document", limits: "512 MB, 100 ops/s, 1 free cluster per project", sleep: "Pauses after 30 days with no connections", card: "Unverified", asia: "Region support unverified", drizzle: "No", monitor: "Free cluster metrics unverified", adapter: "none", pick: "Standard document DB", url: "https://www.mongodb.com/pricing" , checked: FIRST_CHECKED_ON },
  { name: "Prisma Postgres", type: "Postgres", limits: "50 DBs, 1 GB, 200k operations a month", sleep: "Unverified", card: "No", asia: "Singapore, Tokyo", drizzle: "Yes", monitor: "No usage API", adapter: "none", pick: "Small apps (ops cap is tight)", url: "https://www.prisma.io/pricing" , checked: FIRST_CHECKED_ON },
  { name: "Convex", type: "Reactive TypeScript backend", limits: "1M function calls, 0.5 GB DB, 1 GB egress", sleep: "No pausing, writes fail at the cap", card: "Unverified", asia: "Sydney only", drizzle: "No", monitor: "No usage API", adapter: "none", pick: "Realtime apps", url: "https://www.convex.dev/pricing" , checked: FIRST_CHECKED_ON },
  { name: "Aiven", type: "Postgres, MySQL, Valkey", limits: "Postgres: 1 GB storage, 1 GB RAM, 1 CPU", sleep: "May power off when unused (emails first)", card: "No", asia: "Region picked for you", drizzle: "Yes", monitor: "API unverified", adapter: "none", pick: "A real small VM", url: "https://aiven.io/pricing" , checked: FIRST_CHECKED_ON },
  { name: "Nile", type: "Postgres (multi-tenant)", limits: "1 GB, 50M query tokens, 500 connections", sleep: "Never pauses", card: "Unverified", asia: "Unverified", drizzle: "Unverified", monitor: "API unverified", adapter: "none", pick: "B2B SaaS tenants", url: "https://www.thenile.dev/pricing" , checked: FIRST_CHECKED_ON },
];

export const NOT_FREE: [string, string][] = [
  ["CockroachDB", "Free Basic plan ended September 2026. Now a 30-day trial."],
  ["PlanetScale", "No free plan. Cheapest is $5 a month."],
  ["Xata", "14-day trial only (self-hosting is free)."],
  ["Fauna", "Shut down in 2025."],
  ["Render Postgres", "Free DB expires after 30 days."],
  ["Railway", "$5 trial, then $1 a month in credit."],
  ["Appwrite Cloud", "Free, but pauses after 7 days without console activity and deletes 90 days later."],
  ["Couchbase Capella", "Turns off after 72 h idle and deletes after 30 days."],
  ["Redis Cloud", "Free, but only 30 MB."],
];

// The mockup's four picks: [need, best pick, also good].
export const PICKS: [string, string, string][] = [
  ["Relational SQL", "Neon", "Turso or TiDB"],
  ["Document", "Firestore", "MongoDB Atlas"],
  ["Cache and queues", "Upstash Redis", "none needed"],
  ["Realtime backend", "Supabase", "Convex"],
];

// "Console can monitor" = an adapter exists or its usage API is known (mockup: monitorable).
export const canMonitor = (d: FreeDb): boolean => d.adapter !== "none";
