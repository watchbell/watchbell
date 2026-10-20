import { readData, neonData, supabaseData, tursoData, upstashData } from "@/lib/databases/snapshot-data";
import type { DbKind, DbOption } from "@/lib/links";

// What the Edit link dialog shows under a database's name, so two databases with the same name can be told apart:
// the region and an identifier you can match against the app's connection string (Supabase project ref, Neon endpoint
// and project id, Firebase project id). Read from the snapshot and the resource row only; nothing here calls a provider.
export function dbOptionFrom(r: { id: string; name: string; kind: DbKind; account: string; externalId: string; data: unknown }): DbOption {
  const base = { id: r.id, name: r.name, kind: r.kind, account: r.account };
  if (r.kind === "supabase_project") {
    return { ...base, region: readData(supabaseData, r.data).region ?? null, ident: `ref ${r.externalId}` };
  }
  if (r.kind === "neon_project") {
    const d = readData(neonData, r.data);
    const main = d.branches?.find((b) => b.isDefault)?.id;
    const ep = d.endpoints?.find((e) => e.branchId === main) ?? d.endpoints?.[0];
    return { ...base, region: d.region ?? null, ident: ep ? `${ep.id} · project ${r.externalId}` : `project ${r.externalId}` };
  }
  // Stage 8: what an app's connection string shows (libsql://<db>-<org>…, the Upstash endpoint, the D1 binding's id).
  if (r.kind === "turso_database") {
    const d = readData(tursoData, r.data);
    return { ...base, region: d.primaryRegion ?? null, ident: d.org ? `org ${d.org}` : null };
  }
  if (r.kind === "upstash_redis") return { ...base, region: readData(upstashData, r.data).region ?? null, ident: `id ${r.externalId}` };
  if (r.kind === "d1_database") return { ...base, region: null, ident: `id ${r.externalId}` };
  return { ...base, region: null, ident: `project ${r.externalId}` };
}
