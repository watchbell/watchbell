import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { events } from "@/db/schema";
import { REPEAT_WINDOW_MS, reasonFor, repeatable } from "@/lib/events/reasons";
import type { State } from "@/lib/status";

export type EventInput = {
  at?: Date; resourceId: string | null; type: "deployment" | "monitor" | "database" | "system" | "action";
  kind: State; message: string; detail: string | null; actorUserId?: string | null; reason?: string | null;
};
type Conn = Pick<ReturnType<typeof db>, "insert" | "update">;

// The one way to write events (R2). A repeatable reason first tries to bump the latest row with the same reason and
// resource whose last occurrence is within the hour: count + 1, last_at and the newest detail and kind. Only when no
// row matched is a new one inserted. Runs on the caller's transaction when one is passed.
export async function recordEvents(list: (EventInput | null)[], conn: Conn = db()): Promise<void> {
  for (const e of list) {
    if (!e) continue;
    const at = e.at ?? new Date();
    const reason = reasonFor(e);
    if (repeatable(reason)) {
      const since = new Date(at.getTime() - REPEAT_WINDOW_MS);
      const bumped = await conn.update(events)
        .set({ count: sql`${events.count} + 1`, lastAt: sql`greatest(coalesce(${events.lastAt}, ${events.at}), ${at.toISOString()}::timestamptz)`, detail: e.detail, kind: e.kind })
        .where(sql`${events.id} = (select id from ops.events where reason = ${reason} and resource_id is not distinct from ${e.resourceId}::uuid
          and message = ${e.message}
          and coalesce(last_at, at) >= ${since.toISOString()}::timestamptz order by coalesce(last_at, at) desc limit 1)`)
        .returning({ id: events.id });
      if (bumped.length) continue;
    }
    await conn.insert(events).values({
      at, resourceId: e.resourceId, type: e.type, kind: e.kind, message: e.message, detail: e.detail,
      actorUserId: e.actorUserId ?? null, reason, count: 1,
    });
  }
}
