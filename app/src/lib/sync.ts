import type { Provider } from "@/lib/providers/info";
import { supabaseState } from "@/lib/databases/supabase";

export type ExistingResource = { id: string; externalId: string; monitored: boolean; teamId: string | null };
type Found = { externalId: string; name: string; meta: Record<string, unknown> };
export type SyncPlan = {
  insert: (Found & { monitored: boolean })[];
  update: { id: string; name: string; meta: Record<string, unknown> }[];
  gone: string[];
};

export const FRESH_MS = 24 * 3_600_000;

// keepTeamIds: teams the token couldn't read this time (403). Their apps weren't listed, which says nothing about
// whether they still exist, so they are left as they are instead of being marked gone.
export function planSync(existing: ExistingResource[], found: Found[], opts: { watchNew: boolean; keepTeamIds?: string[] }): SyncPlan {
  const byExternal = new Map(existing.map((e) => [e.externalId, e]));
  const seen = new Set(found.map((f) => f.externalId));
  const keep = new Set(opts.keepTeamIds ?? []);
  return {
    update: found.filter((f) => byExternal.has(f.externalId)).map((f) => ({ id: byExternal.get(f.externalId)!.id, name: f.name, meta: f.meta })),
    insert: found.filter((f) => !byExternal.has(f.externalId)).map((f) => ({ ...f, monitored: opts.watchNew })),
    gone: existing.filter((e) => !seen.has(e.externalId) && !(e.teamId !== null && keep.has(e.teamId))).map((e) => e.id),
  };
}

// "New" in the Sync dialog and the "N new" pill: first seen in the last 24 h and not ticked yet.
export function isFresh(r: { firstSeenAt: Date; monitored: boolean }, now: Date): boolean {
  return !r.monitored && now.getTime() - r.firstSeenAt.getTime() < FRESH_MS;
}

// `kind`: the account's sync kind. An account can hold other kinds of rows (stage 4's domains under the Vercel account),
// which are not what Sync lists, saves or counts.
export function monitoredSummary(rows: { kind?: string; monitored: boolean; firstSeenAt: Date; goneAt: Date | null }[], now: Date, kind?: string | null): { on: number; total: number; fresh: number } {
  const live = rows.filter((r) => !r.goneAt && (!kind || r.kind === kind));
  return { on: live.filter((r) => r.monitored).length, total: live.length, fresh: live.filter((r) => isFresh(r, now)).length };
}

// The one kind of resource each provider's Sync lists, saves and counts. An account can hold other kinds too (stage 4
// GitHub has a Sync of its own (repositories are not ops.resources rows: lib/data/github-db.ts).
// stores domains under the Vercel account); those are never Sync's to list, untick or count.
export const SYNC_KIND = {
  vercel: "app", supabase: "supabase_project", neon: "neon_project", firebase: "firestore", cloudflare: "zone",
  turso: "turso_database", upstash: "upstash_redis", // stage 8 (Cloudflare D1 rides on the Cloudflare account, collector-discovered)
} as const satisfies Record<Exclude<Provider, "github" | "github_write">, string>;

export type SyncProvider = keyof typeof SYNC_KIND;
export type SyncKind = (typeof SYNC_KIND)[SyncProvider];
export const SYNC_PROVIDERS = Object.keys(SYNC_KIND) as SyncProvider[];
// null: no Sync for that provider (Drive, or anything unknown).
export const syncKind = (provider: string): SyncKind | null =>
  Object.hasOwn(SYNC_KIND, provider) ? SYNC_KIND[provider as SyncProvider] : null;

const s = (v: unknown) => (typeof v === "string" && v ? v : null);

export function syncRowSub(kind: string, meta: Record<string, unknown>): string {
  if (kind === "app") return `Vercel project${s(meta.teamName) ? ` · ${meta.teamName}` : ""}`;
  if (kind === "zone") return `Cloudflare zone · ${s(meta.status) ?? "unknown"}`;
  if (kind === "supabase_project") return ["Supabase project", s(meta.status) ? supabaseState(String(meta.status)).label : null, s(meta.region)].filter(Boolean).join(" · ");
  if (kind === "neon_project") return ["Neon project", s(meta.region)].filter(Boolean).join(" · ");
  if (kind === "turso_database") return ["Turso database", s(meta.group) ? `group ${meta.group}` : null, s(meta.region)].filter(Boolean).join(" · ");
  if (kind === "upstash_redis") return ["Upstash Redis", s(meta.region)].filter(Boolean).join(" · ");
  return "Firebase project";
}

export type SyncBadge = "app" | "db" | "fs" | "dom";
export const badgeOf = (kind: string): SyncBadge => (kind === "app" ? "app" : kind === "zone" ? "dom" : kind === "firestore" ? "fs" : "db");
