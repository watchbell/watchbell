import { accounts, keepActive, links, resources, settings, snapshots } from "@/db/schema";
import { supabaseMetrics, supabaseMetricsKeys } from "@/db/compute-schema";
import { hourStart } from "@/lib/databases/compute-metrics";
import { neonProjectState } from "@/lib/databases/neon";
import type { DbKind } from "@/lib/links";
import { D1_ACCESS_KEY } from "@/lib/view/extra-dbs";
import type { SeededApps } from "./apps";
import { ago, DAY, HOUR, MINUTE, type SeedCtx } from "./context";
import { DB_NAMES } from "./names";
import { rngFor, stableHex, stableId, stableToken } from "./rng";

// Six watched databases, one per provider the console reads (Supabase, Neon, Firestore, Turso, Upstash Redis and
// Cloudflare D1), each under its own made-up account, with the snapshot fields the collector's database tasks write
// (lib/databases/snapshot-data.ts) and the usage numbers the Databases pages and Free databases read. Every number is
// comfortably under its free-plan alert threshold, so the seeded alerts stay the only firing ones. Most apps use one
// of them (ops.links uses_db), and the Supabase project has compute metrics (Stage 12) and Keep active on.

export type SeededDb = { id: string; kind: DbKind; name: string; externalId: string; accountId: string };
export type SeededDatabases = { dbs: SeededDb[]; cloudflare: { accountId: string; cfAccountId: string; label: string } };

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const PLACEHOLDER = "demo"; // not a credential: nothing in the demo calls a provider, so nothing is ever decrypted

type Provider = "supabase" | "neon" | "firebase" | "turso" | "upstash" | "cloudflare";
const CREDENTIAL_KIND: Record<Provider, string> = {
  supabase: "Access token", neon: "API key", firebase: "Service account", turso: "Platform API token", upstash: "Developer API key", cloudflare: "API token",
};

export async function seedDatabases(ctx: SeedCtx, seeded: SeededApps): Promise<SeededDatabases> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "databases");
  const team = seeded.team;
  const iso = (d: Date) => d.toISOString();

  // ---- accounts ----
  const accountId = (p: Provider) => stableId(seed, "account", p);
  const providers: Provider[] = ["supabase", "neon", "firebase", "turso", "upstash", "cloudflare"];
  const synced = ago(now, rng.int(4, 40) * MINUTE);
  await db.insert(accounts).values(providers.map((p) => {
    const connected = ago(now, rng.int(60, 280) * DAY);
    return {
      id: accountId(p), provider: p, label: p === "firebase" ? `${team.slug}-firebase` : team.name,
      credentialCiphertext: PLACEHOLDER, credentialIv: PLACEHOLDER, credentialKind: CREDENTIAL_KIND[p],
      status: "ok" as const, lastTestAt: synced, lastSyncAt: synced, createdAt: connected, updatedAt: synced,
    };
  }));
  const cfAccountId = stableHex(32, seed, "cloudflare-account");

  // ---- the six databases ----
  const name = (kind: keyof typeof DB_NAMES) => rng.pick(DB_NAMES[kind]);
  const created = () => ago(now, rng.int(40, 300) * DAY);
  const dbs: (SeededDb & { meta: Record<string, unknown>; createdAt: Date })[] = [
    { kind: "supabase_project", provider: "supabase", externalId: stableToken(20, seed, "supabase-ref").toLowerCase().replace(/[0-9]/g, "x") },
    { kind: "neon_project", provider: "neon", externalId: `${rng.pick(["silent", "quiet", "misty", "bold", "calm"])}-${rng.pick(["river", "meadow", "forest", "harbor", "dune"])}-${stableHex(8, seed, "neon-id")}` },
    { kind: "firestore", provider: "firebase", externalId: `${team.slug.split("-")[0]}-notes-${stableHex(5, seed, "firebase-id")}` },
    { kind: "turso_database", provider: "turso", externalId: stableId(seed, "turso-db") },
    { kind: "upstash_redis", provider: "upstash", externalId: stableId(seed, "upstash-db") },
    { kind: "d1_database", provider: "cloudflare", externalId: stableId(seed, "d1-db") },
  ].map(({ kind, provider, externalId }) => {
    const n = name(kind as keyof typeof DB_NAMES);
    const at = created();
    const meta: Record<string, unknown> =
      kind === "supabase_project" ? { orgSlug: team.slug, region: "ap-southeast-1", pgVersion: "17.4.1.054", createdAt: iso(at), status: "ACTIVE_HEALTHY" }
      : kind === "neon_project" ? { orgId: `org-${stableHex(8, seed, "neon-org")}`, region: "aws-ap-southeast-1", pgVersion: 17, createdAt: iso(at) }
      : kind === "firestore" ? { projectId: externalId }
      : kind === "turso_database" ? { org: team.slug, group: "default", region: "sin" }
      : kind === "upstash_redis" ? { region: "ap-southeast-1", type: "free" }
      : { accountId: cfAccountId, createdAt: iso(at) };
    return { id: stableId(seed, "db", kind), kind: kind as DbKind, name: n, externalId, accountId: accountId(provider as Provider), meta, createdAt: at };
  });
  await db.insert(resources).values(dbs.map((d) => ({
    id: d.id, accountId: d.accountId, kind: d.kind, externalId: d.externalId, name: d.name, monitored: true, meta: d.meta,
    firstSeenAt: d.createdAt, lastSeenAt: synced, createdAt: d.createdAt, updatedAt: synced,
  })));

  // ---- snapshots: what the hourly / per-minute database tasks last wrote ----
  const byKind = (k: DbKind) => dbs.find((d) => d.kind === k)!;
  const collected = (minutes: number) => ago(now, minutes * MINUTE + rng.int(0, 50) * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthShare = (now.getTime() - monthStart.getTime()) / (monthEnd.getTime() - monthStart.getTime()); // usage grows over the month

  const endpoints = [{
    id: `ep-${stableToken(12, seed, "neon-ep").toLowerCase()}`, branchId: `br-${stableToken(12, seed, "neon-br-main").toLowerCase()}`,
    state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 2, lastActive: iso(ago(now, rng.int(20, 300) * MINUTE)),
  }];
  const computeSeconds = Math.round((8 + 50 * monthShare + rng.int(0, 10)) * 3600);
  const neon = neonProjectState({ endpoints, computeSeconds });

  const rows: { id: string; state: "ok" | "idle"; since: Date; at: Date; data: Record<string, unknown> }[] = [
    { id: byKind("supabase_project").id, state: "ok", since: ago(now, rng.int(20, 90) * DAY), at: collected(1), data: {
      status: "ACTIVE_HEALTHY", region: "ap-southeast-1", pgVersion: "17.4.1.054", orgSlug: team.slug, freeOrg: true,
      lastTrafficAt: iso(ago(now, rng.int(3, 50) * MINUTE)), trafficAt: iso(ago(now, rng.int(1, 4) * MINUTE)),
      health: [{ name: "db", status: "ACTIVE_HEALTHY" }, { name: "auth", status: "ACTIVE_HEALTHY" }, { name: "rest", status: "ACTIVE_HEALTHY" }, { name: "storage", status: "ACTIVE_HEALTHY" }],
      healthAt: iso(ago(now, rng.int(1, 4) * MINUTE)), sizeBytes: rng.int(38, 140) * MB + rng.int(0, MB), sizeAt: iso(ago(now, rng.int(4, 20) * HOUR)),
      lastGoodState: "ok",
    } },
    { id: byKind("neon_project").id, state: neon.state === "ok" ? "ok" : "idle", since: ago(now, rng.int(20, 300) * MINUTE), at: collected(rng.int(2, 9)), data: {
      region: "aws-ap-southeast-1", pgVersion: 17, orgId: byKind("neon_project").meta.orgId, computeSeconds,
      transferBytes: Math.round((0.2 + 1.6 * monthShare) * GB), periodStart: iso(monthStart), periodEnd: iso(monthEnd),
      activeSeconds: Math.round(computeSeconds / 1.4), endpoints,
      branches: [
        { id: endpoints[0].branchId, name: "main", isDefault: true, logicalSize: rng.int(120, 380) * MB },
        { id: `br-${stableToken(12, seed, "neon-br-preview").toLowerCase()}`, name: "preview/reporting", isDefault: false, logicalSize: rng.int(60, 160) * MB },
      ],
      lastGoodState: neon.state === "ok" ? "ok" : "idle",
    } },
    { id: byKind("firestore").id, state: "ok", since: ago(now, rng.int(10, 60) * DAY), at: collected(1), data: {
      displayName: byKind("firestore").name, latencyMs: rng.int(70, 190),
      reads: rng.int(4_000, 22_000), writes: rng.int(800, 6_000), deletes: rng.int(20, 400), opsAt: iso(ago(now, rng.int(10, 50) * MINUTE)),
      authUsers: rng.int(80, 2_400), authAt: iso(ago(now, rng.int(2, 20) * HOUR)), lastGoodState: "ok",
    } },
    { id: byKind("turso_database").id, state: "ok", since: ago(now, rng.int(10, 60) * DAY), at: collected(rng.int(5, 50)), data: {
      org: team.slug, group: "default", primaryRegion: "sin", plan: "free", blockReads: false, blockWrites: false,
      rowsRead: Math.round((20 + 140 * monthShare) * 1e6), rowsWritten: Math.round((0.2 + 2.2 * monthShare) * 1e6), storageBytes: rng.int(40, 600) * MB,
      orgRowsRead: Math.round((25 + 160 * monthShare) * 1e6), orgRowsWritten: Math.round((0.3 + 2.6 * monthShare) * 1e6), orgStorageBytes: rng.int(700, 1400) * MB,
      orgDatabases: 3, usageAt: iso(ago(now, rng.int(5, 50) * MINUTE)), lastGoodState: "ok",
    } },
    { id: byKind("upstash_redis").id, state: "ok", since: ago(now, rng.int(10, 60) * DAY), at: collected(rng.int(5, 50)), data: {
      region: "ap-southeast-1", status: "active", type: "free",
      dailyCommands: rng.int(2_000, 9_000), monthlyRequests: Math.round((20 + 180 * monthShare) * 1000) + rng.int(0, 999),
      storageBytes: rng.int(6, 90) * MB, monthlyBandwidthBytes: Math.round((0.1 + 2.4 * monthShare) * GB), statsAt: iso(ago(now, rng.int(5, 50) * MINUTE)),
      lastGoodState: "ok",
    } },
    { id: byKind("d1_database").id, state: "ok", since: ago(now, rng.int(10, 60) * DAY), at: collected(rng.int(5, 50)), data: {
      accountId: cfAccountId, createdAt: iso(byKind("d1_database").createdAt), sizeBytes: rng.int(4, 120) * MB, numTables: rng.int(4, 12),
      readReplication: "disabled", detailsAt: iso(ago(now, rng.int(5, 50) * MINUTE)),
      rowsRead: rng.int(40_000, 900_000), rowsWritten: rng.int(1_000, 30_000), readQueries: rng.int(4_000, 60_000), writeQueries: rng.int(300, 6_000),
      accountRowsRead: rng.int(900_000, 1_800_000), accountRowsWritten: rng.int(30_000, 55_000), accountSizeBytes: rng.int(200, 900) * MB, accountDatabases: 2,
      usageDay: now.toISOString().slice(0, 10), usageAt: iso(ago(now, rng.int(5, 50) * MINUTE)), lastGoodState: "ok",
    } },
  ];
  await db.insert(snapshots).values(rows.map((r) => ({ resourceId: r.id, state: r.state, stateSince: r.since, collectedAt: r.at, data: r.data })));

  // D1: the hourly task's note per Cloudflare account (both permissions there).
  await db.insert(settings).values({
    key: D1_ACCESS_KEY, value: { [accountId("cloudflare")]: { d1: "ok", analytics: "ok", at: iso(ago(now, rng.int(5, 50) * MINUTE)), note: null } },
    createdAt: ago(now, 30 * DAY), updatedAt: now,
  });

  // Apps → databases (the owner's choice on the app page): most apps use one, a database may serve two.
  const order: DbKind[] = ["supabase_project", "neon_project", "turso_database", "upstash_redis", "firestore", "d1_database", "supabase_project", "neon_project"];
  const linked = seeded.apps.slice(0, Math.max(4, seeded.apps.length - 1));
  await db.insert(links).values(linked.map((a, i) => ({
    id: stableId(seed, "link", a.name), fromResourceId: a.id, toResourceId: byKind(order[i]).id, kind: "uses_db" as const, source: "manual" as const,
    createdAt: ago(now, rng.int(20, 90) * DAY), updatedAt: ago(now, rng.int(1, 19) * DAY),
  })));

  await seedCompute(ctx, byKind("supabase_project").id);
  await db.insert(keepActive).values({ resourceId: byKind("supabase_project").id, keep: true, autoRestore: false, lastKeepAliveAt: ago(now, rng.int(2, 20) * HOUR), updatedAt: ago(now, 12 * DAY) });

  return { dbs: dbs.map(({ id, kind, name, externalId, accountId }) => ({ id, kind, name, externalId, accountId })), cloudflare: { accountId: accountId("cloudflare"), cfAccountId, label: team.name } };
}

// Stage 12 compute of the Supabase project: the newest scrape and 24 hourly rollups, all well under the ComputeHigh
// limits (CPU 80 %, RAM 90 %).
async function seedCompute(ctx: SeedCtx, resourceId: string): Promise<void> {
  const { db, seed, now } = ctx;
  const rng = rngFor(seed, "compute");
  const scraped = ago(now, rng.int(1, 4) * MINUTE);
  const connMax = 60;
  const hours = Array.from({ length: 24 }, (_, i) => {
    const hour = new Date(hourStart(now).getTime() - i * HOUR);
    const cpu = Math.round((6 + 18 * rng.next()) * 10) / 10;
    const mem = Math.round((34 + 14 * rng.next()) * 10) / 10;
    return {
      resourceId, hour, samples: i === 0 ? Math.max(1, Math.floor((now.getTime() - hour.getTime()) / (5 * MINUTE))) : 12, cpuSamples: i === 0 ? 1 : 11,
      cpuAvg: cpu, cpuMax: Math.round(Math.min(70, cpu * (1.4 + rng.next())) * 10) / 10, memAvg: mem, memMax: Math.round(Math.min(85, mem + 6 * rng.next()) * 10) / 10,
      diskPct: 9.8, connUsed: rng.int(8, 22), connMax,
    };
  });
  const latest = {
    cpuPct: hours[0].cpuAvg, memPct: hours[0].memAvg, diskPct: 9.8, connUsed: hours[0].connUsed, connMax, at: scraped.toISOString(), prev: null,
    recent: Array.from({ length: 6 }, (_, i) => ({ at: ago(scraped, (5 - i) * 5 * MINUTE).toISOString(), cpu: Math.round((6 + 18 * rng.next()) * 10) / 10 })),
  };
  await db.insert(supabaseMetricsKeys).values({
    resourceId, keyCiphertext: PLACEHOLDER, keyIv: PLACEHOLDER, latest, lastTryAt: scraped, lastOkAt: scraped,
    createdAt: ago(now, 21 * DAY), updatedAt: scraped,
  });
  await db.insert(supabaseMetrics).values(hours.filter((h) => h.hour.getTime() <= now.getTime()));
}
