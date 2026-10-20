// The one place that knows how stages 3 and 4 store their numbers in ops.snapshots.data. Each stage's own parser does
// the reading (lib/databases/snapshot-data.ts for databases, lib/network/facts.ts for zones and domains), so a field
// renamed there is renamed here by the compiler. Missing or odd values read as null: the rule then holds ("unknown").
import { D1_FREE, d1Shares, topQuota, TURSO_FREE, tursoShares, UPSTASH_FREE, upstashShares } from "@/lib/databases/extra";
import { FIRESTORE_FREE, quotaDayStart } from "@/lib/databases/firebase";
import { NEON_FREE } from "@/lib/databases/neon";
import { d1Data, firebaseData, neonData, readData, supabaseData, tursoData, upstashData } from "@/lib/databases/snapshot-data";
import { FREE_DB_BYTES } from "@/lib/databases/supabase";
import { factsOf } from "@/lib/network/facts";
import { isoDate, pointsToVercel, zoneFor } from "@/lib/network/rules";
import type { State } from "@/lib/status";
import type { DbFact, DnsFact, DomainFact } from "./facts";

type SnapRow = { id: string; name: string; kind: string; state: State; data: Record<string, unknown> };

const DAY = 86_400_000;
// Supabase's usage read covers the last 7 days: an answer without any traffic means "idle for at least 7 days".
const TRAFFIC_WINDOW_DAYS = 7;

export function dbFact(r: SnapRow, now: Date): DbFact | null {
  const blank = { id: r.id, name: r.name, state: r.state, sizeBytes: null, sizeLimitBytes: null, lastApiAt: null, cuHours: null, cuLimit: null, readsToday: null, readsLimit: null, quotaExhausted: null };
  if (r.kind === "supabase_project") {
    const d = readData(supabaseData, r.data);
    // lastTrafficAt is null both when the read never ran and when it found no traffic; trafficAt says which.
    const traffic = isoDate(d.lastTrafficAt);
    const readAt = isoDate(d.trafficAt);
    const lastApiAt = traffic ?? (readAt && !d.trafficError ? new Date(readAt.getTime() - TRAFFIC_WINDOW_DAYS * DAY) : null);
    return { ...blank, provider: "supabase", sizeBytes: d.sizeBytes ?? null, sizeLimitBytes: FREE_DB_BYTES, lastApiAt };
  }
  if (r.kind === "neon_project") {
    const d = readData(neonData, r.data);
    const sizes = (d.branches ?? []).map((b) => b.logicalSize).filter((n): n is number => typeof n === "number");
    return {
      ...blank, provider: "neon",
      cuHours: d.computeSeconds == null ? null : d.computeSeconds / 3600, cuLimit: NEON_FREE.cuHours,
      // Same total as the Neon page (sum of the branches' logical sizes) against the 1 GB free storage.
      sizeBytes: sizes.length ? sizes.reduce((n, x) => n + x, 0) : null, sizeLimitBytes: NEON_FREE.storageBytes,
    };
  }
  if (r.kind === "firestore") {
    const d = readData(firebaseData, r.data);
    // `reads` counts since midnight Pacific when it was read; a count from before today's reset says nothing about today.
    const opsAt = isoDate(d.opsAt);
    const readsToday = d.reads != null && opsAt && opsAt.getTime() >= quotaDayStart(now).getTime() ? d.reads : null;
    const pinged = d.latencyMs != null || d.pingError != null;
    return {
      ...blank, provider: "firestore", readsToday, readsLimit: FIRESTORE_FREE.reads,
      quotaExhausted: pinged ? d.pingReason === "RESOURCE_EXHAUSTED" : null,
    };
  }
  // Stage 8. Storage (StorageAlmostFull) and the top usage quota (DbQuotaHigh), from the same shares the pages show.
  if (r.kind === "turso_database") {
    const d = readData(tursoData, r.data);
    const q = topQuota(tursoShares(d, now));
    return { ...blank, provider: "turso", sizeBytes: d.orgStorageBytes ?? null, sizeLimitBytes: TURSO_FREE.storageBytes, quotaPct: q?.pct ?? null, quotaLabel: q ? `${q.label} ${q.text}` : null };
  }
  if (r.kind === "upstash_redis") {
    const d = readData(upstashData, r.data);
    const q = topQuota(upstashShares(d, now));
    return { ...blank, provider: "upstash", sizeBytes: d.storageBytes ?? null, sizeLimitBytes: UPSTASH_FREE.storageBytes, quotaPct: q?.pct ?? null, quotaLabel: q ? `${q.label} ${q.text}` : null };
  }
  if (r.kind === "d1_database") {
    const d = readData(d1Data, r.data);
    const q = topQuota(d1Shares(d, now));
    return { ...blank, provider: "d1", sizeBytes: d.sizeBytes ?? null, sizeLimitBytes: D1_FREE.dbBytes, quotaPct: q?.pct ?? null, quotaLabel: q ? `${q.label} ${q.text}` : null };
  }
  return null;
}

// Stage 4 keeps the TLS certificate on each domain row (data.tls) and RDAP on its Cloudflare zone (data.rdap): a
// zone gives DomainExpiringSoon, a domain gives CertExpiringSoon. Null when neither kind exists yet (S1).
export function domainFacts(zones: SnapRow[], domains: SnapRow[]): DomainFact[] | null {
  if (!zones.length && !domains.length) return null;
  return [
    ...zones.map((z) => ({ id: z.id, name: z.name, tlsNotAfter: null, expiresAt: isoDate(factsOf(z.data).rdap?.expiresAt) })),
    ...domains.map((d) => ({ id: d.id, name: d.name, tlsNotAfter: isoDate(factsOf(d.data).tls?.notAfter), expiresAt: null })),
  ];
}

// DNS records live in the zone's snapshot (data.records, from the hourly Cloudflare read); there are no record rows.
// Each record that points to Vercel is one subject (`zoneId:recordId`), raised on the app's domain row when one matches
// the host, else on the zone. Vercel's recommended addresses come from the domains' Vercel config, as on the DNS page.
// Null until some zone has its records read; a zone whose records were never read adds nothing.
export function dnsFacts(zones: SnapRow[], domains: SnapRow[]): DnsFact[] | null {
  const read = zones.filter((z) => Array.isArray(z.data.records));
  if (!read.length) return null;
  const zoneNames = zones.map((z) => z.name);
  const out: DnsFact[] = [];
  for (const z of read) {
    const inZone = domains.filter((d) => zoneFor(d.name, zoneNames) === z.name.toLowerCase().replace(/\.$/, ""));
    const extraIps = [...new Set(inZone.flatMap((d) => factsOf(d.data).vercel?.recommendedIps ?? []))];
    for (const rec of factsOf(z.data).records) {
      if (!pointsToVercel(rec, extraIps)) continue;
      const host = rec.name.toLowerCase().replace(/\.$/, "");
      const domain = inZone.find((d) => d.name.toLowerCase().replace(/\.$/, "") === host);
      out.push({ id: `${z.id}:${rec.id}`, resourceId: domain?.id ?? z.id, name: rec.name, proxied: rec.proxied, pointsToVercel: true });
    }
  }
  return out;
}
