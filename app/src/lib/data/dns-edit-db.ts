import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { snapshots } from "@/db/schema";
import { TAG } from "@/lib/cache/tags";
import { updateTags } from "@/lib/cache/invalidate";
import { refreshNetworkStates } from "@/lib/collector/network";
import { withRecord } from "@/lib/network/dns-edit";
import { factsOf } from "@/lib/network/facts";
import type { DnsRecord } from "@/lib/network/rules";

// Stage 6 slice 2 (plan B8): after a DNS edit (or a stale answer), the zone's snapshot takes the record as Cloudflare
// has it, the zone and domain states are derived again (so "proxied in front of Vercel" clears at once), and the cached
// DNS and Domains reads expire. Only the `records` key changes: collected_at stays the hourly read's time.
export async function storeRecord(zoneResourceId: string, record: DnsRecord): Promise<void> {
  const [row] = await db().select({ data: snapshots.data }).from(snapshots).where(eq(snapshots.resourceId, zoneResourceId)).limit(1);
  const records = factsOf(row?.data).records;
  if (!records.some((r) => r.id === record.id)) return; // beyond the first 2,000 records, or not read yet: nothing to update
  const patch = { records: withRecord(records, record) };
  await db().update(snapshots).set({ data: sql`${snapshots.data} || ${JSON.stringify(patch)}::jsonb` }).where(eq(snapshots.resourceId, zoneResourceId));
  await refreshNetworkStates(new Date());
  updateTags([TAG.zones, TAG.domains]);
}
