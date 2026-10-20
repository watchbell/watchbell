import "server-only";
import { desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events, resources } from "@/db/schema";
import { eventSource } from "@/lib/events/reasons";
import type { State } from "@/lib/status";
import { PAGE_ROWS } from "@/lib/view/windows";

export type EventRow = {
  id: string; at: Date; lastAt: Date | null; count: number; reason: string | null; type: string; kind: State;
  message: string; detail: string | null; resource: string; resourceId: string | null;
};

// Drizzle drops the LIMIT for NaN or a negative number, so always land in 1..PAGE_ROWS.events.
const clampLimit = (n: number) => Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : PAGE_ROWS.events, PAGE_ROWS.events));
const latest = sql`coalesce(${events.lastAt}, ${events.at})`;

// Newest occurrence first (a bumped row moves to the top, R2), at most 200 (R8). Events without a resource are the
// collector's own (system) or the console's.
// `excludeActions` leaves out what the owner did in the console (Refresh now, Check now): Overview's few recent events
// are for changes the collector noticed, and the Events page shows both (M4).
export async function listEvents(limit: number = PAGE_ROWS.events, opts: { excludeActions?: boolean } = {}): Promise<EventRow[]> {
  const rows = await db().select({ e: events, name: resources.name }).from(events)
    .leftJoin(resources, eq(resources.id, events.resourceId))
    .where(opts.excludeActions ? ne(events.type, "action") : undefined)
    .orderBy(desc(latest)).limit(clampLimit(limit));
  return rows.map(({ e, name }) => ({
    id: e.id, at: e.at, lastAt: e.lastAt ?? null, count: e.count ?? 1, reason: e.reason ?? null, type: e.type, kind: e.kind,
    message: e.message, detail: e.detail, resourceId: e.resourceId ?? null,
    resource: eventSource({ type: e.type, reason: e.reason ?? null, message: e.message, resource: name }),
  }));
}
