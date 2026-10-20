import type { TaskName } from "@/lib/collector/schedule";
import type { DbKind } from "@/lib/links";

// Perf P3 (owner, 13 Oct 2026): slow-changing reads are cached for at most 5 minutes, and every writer of that data
// expires its tag, so a page is never staler than the database. Real-time data (app and monitor status, alerts,
// events, Overview health and activity) is never cached.
export const CACHE_SECONDS = 300;

// Bump when a cached reader's return shape changes (DbRow, DomainView, ZoneView, the provider status row) in a way a
// deployment of the same commit id could meet, e.g. a local `next start` ("local") after a code change.
export const CACHE_VERSION = "5"; // 2: SlotInput carries the project id; 3: the alias book has accounts and hosts; 4: ZoneView.accountId; 5: the alias book has teams

// Review I1: unstable_cache keeps entries across deployments, so every key carries the deployment it was written by:
// Vercel's deployment id (system env var), else the commit, else Next's NEXT_DEPLOYMENT_ID, else "local"; plus
// CACHE_VERSION. A preview or demo deployment of the same project therefore never shares entries with production.
// Only a plain id is accepted (letters, digits, "_", "-", ".", up to 64), so nothing like a URL, host or secret can
// reach the key.
const PLAIN_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export function cacheBuildKey(env: Record<string, string | undefined>): string {
  const id = [env.VERCEL_DEPLOYMENT_ID, env.VERCEL_GIT_COMMIT_SHA, env.NEXT_DEPLOYMENT_ID].find((v) => v !== undefined && v !== "");
  return `${id !== undefined && PLAIN_ID.test(id) ? id : "local"}.v${CACHE_VERSION}`;
}

export const TAG = {
  supabase: "db:supabase",
  neon: "db:neon",
  firebase: "db:firebase",
  extraDbs: "db:extra", // stage 8: Turso, Upstash Redis, Cloudflare D1
  zones: "net:zones",
  domains: "net:domains",
  status: "status",
} as const;
export type CacheTag = (typeof TAG)[keyof typeof TAG];

export const ALL_TAGS: CacheTag[] = Object.values(TAG);
export const DB_TAGS: Record<DbKind, CacheTag> = {
  supabase_project: TAG.supabase, neon_project: TAG.neon, firestore: TAG.firebase,
  turso_database: TAG.extraDbs, upstash_redis: TAG.extraDbs, d1_database: TAG.extraDbs,
};

// What each collector task writes. Every network task (cloudflare, domains, tls, rdap, eol) is followed by
// refreshNetworkStates, which rewrites zone AND domain states and reasons (time-driven thresholds included), so each
// expires both network tags (review m1). The Domains list also reads the zone's DNS records and RDAP.
const TASK_TAGS: Partial<Record<TaskName, CacheTag[]>> = {
  supabase: [TAG.supabase],
  supabaseUsage: [TAG.supabase],
  neon: [TAG.neon],
  firebase: [TAG.firebase],
  firebaseUsage: [TAG.firebase],
  extraDbs: [TAG.extraDbs],
  cloudflare: [TAG.zones, TAG.domains],
  domains: [TAG.zones, TAG.domains],
  tls: [TAG.zones, TAG.domains],
  rdap: [TAG.zones, TAG.domains],
  eol: [TAG.zones, TAG.domains],
  status: [TAG.status],
};

export function tagsForTasks(tasks: readonly TaskName[]): CacheTag[] {
  return [...new Set(tasks.flatMap((t) => TASK_TAGS[t] ?? []))];
}

// unstable_cache stores a JSON copy, which would hand a Date back as a string on every hit (but as a Date on a miss).
// The cached readers pack their result into a JSON-safe tree with Dates and Maps marked, and unpack it after the cache.
const DATE = "__ocDate";
const MAP = "__ocMap";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function pack(value: unknown): Json {
  if (value instanceof Date) return { [DATE]: value.toISOString() };
  if (value instanceof Map) return { [MAP]: [...value.entries()].map(([k, v]) => [pack(k), pack(v)]) };
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, pack(v)]));
  }
  return value === undefined ? null : (value as Json);
}

export function unpack<T>(value: Json): T {
  const walk = (v: Json): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      if (typeof v[DATE] === "string" && Object.keys(v).length === 1) return new Date(v[DATE]);
      if (Array.isArray(v[MAP]) && Object.keys(v).length === 1) return new Map((v[MAP] as Json[][]).map(([k, x]) => [walk(k), walk(x)]));
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
