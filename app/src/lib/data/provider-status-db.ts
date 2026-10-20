import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { type FeedIncident, providerStatus, settings } from "@/db/schema";
import { recordEvents } from "@/lib/data/events-write";
import { FEED_ORDER, FEEDS, type FeedProvider, readFeed } from "@/lib/providers/status-feeds";
import type { State } from "@/lib/status";
import { ago } from "@/lib/time";

const STALE_MS = 30 * 60_000;
const COLOS_KEY = "status.cloudflareColos";

// The `status` task: read all six feeds side by side (5 s each), store each, and write an event when a provider goes
// from fine to an incident or back. A failing feed keeps its last reading for 30 minutes, then shows unknown (§16).
export async function taskStatus(now: Date): Promise<void> {
  const [colosRow] = await db().select().from(settings).where(eq(settings.key, COLOS_KEY)).limit(1);
  const colos = Array.isArray(colosRow?.value) ? (colosRow.value as unknown[]).filter((c): c is string => typeof c === "string") : undefined;
  const before = new Map((await db().select().from(providerStatus)).map((r) => [r.provider, r]));
  const results = await Promise.all(FEED_ORDER.map((p) => readFeed(p, now, { colos })));
  const evs = [];
  for (const [i, p] of FEED_ORDER.entries()) {
    const r = results[i];
    const prev = before.get(p);
    if (r.ok) {
      const { state, indicator, description, incidents } = r.reading;
      await db().insert(providerStatus).values({ provider: p, state, indicator, description, incidents, checkedAt: now, lastOkAt: now, error: null })
        .onConflictDoUpdate({ target: providerStatus.provider, set: { state, indicator, description, incidents, checkedAt: now, lastOkAt: now, error: null } });
      const was = prev?.state ?? "unknown";
      const bad = (s: string) => s === "warn" || s === "err";
      if (bad(state) && !bad(was)) evs.push({ type: "system" as const, kind: state, message: `${FEEDS[p].label} reports an incident`, detail: description, resourceId: null, reason: "ProviderIncident" });
      if (!bad(state) && bad(was)) evs.push({ type: "system" as const, kind: "ok" as const, message: `${FEEDS[p].label} incident resolved`, detail: description, resourceId: null, reason: "ProviderRecovered" });
    } else {
      const stale = !prev?.lastOkAt || now.getTime() - prev.lastOkAt.getTime() > STALE_MS;
      await db().insert(providerStatus).values({ provider: p, state: "unknown", checkedAt: now, error: r.error })
        .onConflictDoUpdate({ target: providerStatus.provider, set: { checkedAt: now, error: r.error, ...(stale ? { state: "unknown" as const } : {}) } });
    }
  }
  await recordEvents(evs);
}

export type ProviderRow = {
  provider: FeedProvider; label: string; feedText: string; page: string; state: State; text: string; incidents: FeedIncident[]; checked: string;
};

export type StoredProviderStatus = typeof providerStatus.$inferSelect;

// The stored readings as they are (the Provider status page caches these, perf P3); the page text is worked out per
// request by providerStatusView, so "checked 2 min ago" is never frozen in the cache.
export async function readProviderStatus(): Promise<StoredProviderStatus[]> {
  return db().select().from(providerStatus);
}

export async function listProviderStatus(now: Date): Promise<ProviderRow[]> {
  return providerStatusView(await readProviderStatus(), now);
}

export function providerStatusView(stored: StoredProviderStatus[], now: Date): ProviderRow[] {
  const rows = new Map(stored.map((r) => [r.provider, r]));
  return FEED_ORDER.map((p): ProviderRow => {
    const r = rows.get(p);
    const base = { provider: p, ...FEEDS[p] };
    if (!r) return { ...base, state: "unknown", text: "Not read yet", incidents: [], checked: "—" };
    const failing = r.error !== null;
    const text = r.state === "unknown"
      ? `Feed didn't answer · last read ${r.lastOkAt ? ago(r.lastOkAt, now) : "never"}`
      : r.description || (r.state === "ok" ? "No open incidents" : "Incident");
    return { ...base, state: r.state, text, incidents: r.incidents, checked: ago(failing && r.lastOkAt ? r.lastOkAt : r.checkedAt, now) };
  });
}
