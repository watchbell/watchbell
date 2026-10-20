import "server-only";
import { aliasBook, listDatabases } from "@/lib/data/cached";
import { readCompute } from "@/lib/data/supabase-metrics-db";
import { usagePhrases, usageRows } from "@/lib/view/usage";

// Stage 12: each watched database's usage phrase by its alias (db-a, …), for the office patrol's Databases room, e.g.
// "CPU 12 %, RAM 41 %, disk 8 %, connections 9/60" or "Compute 41 % of 100 CU-h". Aliases only, never names.
export async function dbUsageByAlias(now: Date): Promise<Map<string, string>> {
  const [supabase, neon, firestore, turso, upstash, d1, book] = await Promise.all([
    listDatabases("supabase_project"), listDatabases("neon_project"), listDatabases("firestore"),
    listDatabases("turso_database"), listDatabases("upstash_redis"), listDatabases("d1_database"), aliasBook(),
  ]);
  const compute = await readCompute(supabase.map((r) => r.id), now);
  return usagePhrases(usageRows({ supabase, neon, firestore, compute, turso, upstash, d1 }, now, book), compute, now);
}
