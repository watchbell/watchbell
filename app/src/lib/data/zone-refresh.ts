import "server-only";
import { TAG } from "@/lib/cache/tags";
import { updateTags } from "@/lib/cache/invalidate";
import { refreshNetworkStates } from "@/lib/collector/network";
import { mergeSnapshot } from "@/lib/data/snapshots-db";
import { listDnsRecords } from "@/lib/providers/cloudflare";

// After an approved DNS-record create: read that one zone's records now (the same GET + snapshot merge the hourly
// Cloudflare read does), derive the zone and domain states again, and expire the cached DNS and Domains reads, so the
// new record shows at once. Never throws: the create already happened, and the hourly read catches up on any failure.
export async function refreshZoneRecords(zoneResourceId: string, token: string, zoneExternalId: string, opts: { fetch?: typeof fetch } = {}): Promise<boolean> {
  try {
    const recs = await listDnsRecords(token, zoneExternalId, opts);
    if (!recs.ok) {
      console.warn(`dns refresh: couldn't read the zone's records (${recs.kind})`);
      return false;
    }
    const now = new Date();
    await mergeSnapshot(zoneResourceId, { records: recs.data.records, recordsTruncated: recs.data.truncated }, now);
    await refreshNetworkStates(now);
    updateTags([TAG.zones, TAG.domains]);
    return true;
  } catch (e) {
    console.warn("dns refresh failed:", e instanceof Error ? e.name : "error");
    return false;
  }
}
