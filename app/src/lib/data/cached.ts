import "server-only";
import { unstable_cache } from "next/cache";
import { type CacheTag, CACHE_SECONDS, cacheBuildKey, DB_TAGS, pack, TAG, unpack } from "@/lib/cache/tags";
import type { DbKind } from "@/lib/links";
import { isCloud } from "@/lib/mode";
import * as aliases from "./aliases-db";
import * as dbs from "./databases-db";
import * as net from "./network-db";
import * as status from "./provider-status-db";

// Perf P3: the slow-changing reads the pages use, cached across requests for at most CACHE_SECONDS (5 min) and expired
// by tag whenever the collector, Sync, Re-check or a link edit writes that data (lib/cache/invalidate.ts).
//
// Why unstable_cache: Next 16.4 still supports it with `revalidate` and `tags` without `cacheComponents`, which would
// change how every page renders; `"use cache"` needs that flag.
//
// Safety: these are console-wide reads with no per-user input. Membership is checked by the page before it calls them
// (requirePageMember), never inside, so nothing per-user is cached. They select no credential column (accounts give
// only their label). unstable_cache keys on its key parts plus every argument (JSON), and the callbacks below share
// the same source text, so each one has its own key part.

// Outside cloud (selfhost, demo) the reads are not cached at all: the selfhost scheduler calls them (aliasBook for
// proposal notices) outside any request, where unstable_cache throws "incrementalCache missing", and a local database
// is cheap to read. Tag expiry is a no-op there too (lib/cache/invalidate.ts). Cloud is unchanged.
//
// The deployment and shape version (review I1): an entry written by another deployment or an older reader shape is
// never read back.
const BUILD = cacheBuildKey(process.env);

function cached<A extends unknown[], R>(key: string[], fn: (...args: A) => Promise<R>, tags: CacheTag[]): (...args: A) => Promise<R> {
  const inner = unstable_cache(async (...args: A) => pack(await fn(...args)), ["ops", BUILD, ...key], { revalidate: CACHE_SECONDS, tags });
  return async (...args: A) => (isCloud() ? unpack<R>(await inner(...args)) : fn(...args));
}

const byKind = Object.fromEntries((Object.keys(DB_TAGS) as DbKind[]).map((kind) => [
  kind, cached(["listDatabases", kind], () => dbs.listDatabases(kind), [DB_TAGS[kind]]),
])) as Record<DbKind, () => Promise<dbs.DbRow[]>>;

export const listDatabases = (kind: DbKind): Promise<dbs.DbRow[]> => byKind[kind]();
export const supabaseSlotInputs = cached(["supabaseSlotInputs"], () => dbs.supabaseSlotInputs(), [TAG.supabase]);
export const databaseOptions = cached(["databaseOptions"], () => dbs.databaseOptions(), [TAG.supabase, TAG.neon, TAG.firebase, TAG.extraDbs]);

export const listDomains = cached(["listDomains"], () => net.listDomains(), [TAG.domains, TAG.zones]);
export const listZoneOptions = cached(["listZoneOptions"], () => net.listZoneOptions(), [TAG.zones]);
export const getZoneView = cached(["getZoneView"], (id: string | null) => net.getZoneView(id), [TAG.zones]);

// Privacy: the db-a, app-a, site-a.example, account-1 letters. Databases and apps are added, renamed and removed only
// by Sync (and Remove from console), which expire every tag; the collector's network tasks write zones and domains.
export const aliasBook = cached(["aliasBook"], () => aliases.readAliasBook(), [TAG.supabase, TAG.neon, TAG.firebase, TAG.extraDbs, TAG.zones, TAG.domains]);

export const readProviderStatus = cached(["providerStatus"], () => status.readProviderStatus(), [TAG.status]);
