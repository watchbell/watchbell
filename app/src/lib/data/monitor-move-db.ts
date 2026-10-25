import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { monitors, resources } from "@/db/schema";
import { domainMove, movedUrl } from "@/lib/domain-move";
import { hostPath } from "@/lib/view/format";
import { type Done, updateMonitor } from "./monitors-db";

// Watchbell 1.2.1: Update monitor (Uptime / the app page) and the safe proposal monitor_update_url. The move is read
// afresh (the monitor's host against its app's stored domains and every other watched project's), so a stale button or
// proposal changes nothing once the monitor already checks a domain of its app. The host becomes the app's primary
// domain; the path and query stay. The write goes through updateMonitor (duplicate check, compare-and-set, fresh state).
export async function moveMonitorToDomain(id: string, update: typeof updateMonitor = updateMonitor): Promise<Done> {
  const [row] = await db().select({ m: monitors, appName: resources.name, appMeta: resources.meta }).from(monitors)
    .innerJoin(resources, eq(resources.id, monitors.resourceId)).where(eq(monitors.id, id)).limit(1);
  if (!row) return { ok: false, error: "That monitor no longer exists." };
  if (row.m.kind === "heartbeat") return { ok: false, error: "That monitor is a heartbeat; it has no address to update." };
  const others = await db().select({ id: resources.id, name: resources.name, meta: resources.meta }).from(resources)
    .where(and(eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt), ne(resources.id, row.m.resourceId))).limit(500);
  const move = domainMove(row.m.url, { name: row.appName, meta: row.appMeta }, others, { lastError: row.m.lastError });
  if (!move) return { ok: false, error: "Nothing shows this monitor's domain moved (it is still the app's, or never was), so there is nothing to update." };
  let url: string;
  try {
    url = movedUrl(row.m.url, move.to);
  } catch {
    return { ok: false, error: "The app's domain isn't a valid host name, so the monitor was left as it is." };
  }
  const r = await update(id, {
    url, expectedStatus: row.m.expectedStatus, timeoutMs: row.m.timeoutMs, bodyContains: row.m.bodyContains, jsonPath: row.m.jsonPath, jsonEquals: row.m.jsonEquals,
  });
  if (!r.ok) return r;
  return {
    ok: true, message: `Monitor now checks ${url}.`,
    audit: { message: `Monitor moved to the app's new domain: ${hostPath(url)}`, detail: `was ${hostPath(row.m.url)}`, resourceId: row.m.resourceId },
  };
}
