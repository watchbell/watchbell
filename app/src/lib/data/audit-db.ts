import "server-only";
import { recordEvents } from "@/lib/data/events-write";

// Spec §12: every action writes an `events` row of type "action" with the acting user. Callers pass short, already
// sanitised text (host and path only, never a query string, credentials or a token).
export async function recordAction(e: {
  kind: "ok" | "err"; message: string; detail?: string; resourceId: string | null; actorUserId: string | null; // null: the office auto-run (Stage 9)
}): Promise<void> {
  await recordEvents([{ type: "action", kind: e.kind, message: e.message, detail: e.detail ?? null, resourceId: e.resourceId, actorUserId: e.actorUserId, at: new Date() }]);
}
