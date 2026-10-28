import "server-only";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { resources } from "@/db/schema";
import type { NoteSeverity } from "@/private/ai/types";
import { aiNotes } from "@/private/db/schema";

// AI notes pushed by agents (Task 7 writes them): not dismissed, newest first, at most 20, last 30 days (R8).

export const NOTES_MAX = 20;
export const NOTES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

export type NoteView = {
  id: string; appId: string | null; appName: string | null; severity: NoteSeverity; title: string; body: string;
  from: string; model: string | null; at: Date;
};

// `appId` = a console app id: the notes of that app (an agent may have stored the id or the app name, so both match).
// No argument = every note (Overview).
export async function listNotes(appId?: string, now: Date = new Date()): Promise<NoteView[]> {
  let keys: string[] | null = null;
  let known = new Map<string, string>();
  if (appId !== undefined) {
    if (!isUuid(appId)) return [];
    const [r] = await db().select({ name: resources.name }).from(resources).where(eq(resources.id, appId)).limit(1);
    keys = r ? [appId, r.name] : [appId];
    if (r) known = new Map([[appId, r.name]]);
  }
  const since = new Date(now.getTime() - NOTES_TTL_MS);
  const live = and(isNull(aiNotes.dismissedAt), gte(aiNotes.createdAt, since));
  const rows = await db().select({
    id: aiNotes.id, appId: aiNotes.appId, severity: aiNotes.severity, title: aiNotes.title, body: aiNotes.body,
    source: aiNotes.source, client: aiNotes.client, model: aiNotes.model, createdAt: aiNotes.createdAt,
  }).from(aiNotes).where(keys ? and(live, inArray(aiNotes.appId, keys)) : live).orderBy(desc(aiNotes.createdAt)).limit(NOTES_MAX);
  if (appId === undefined) {
    const ids = [...new Set(rows.map((r) => r.appId).filter((x): x is string => !!x && isUuid(x)))];
    if (ids.length) {
      const names = await db().select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, ids)).limit(ids.length);
      known = new Map(names.map((n) => [n.id, n.name]));
    }
  }
  return rows.map((r) => ({
    id: r.id, appId: r.appId, appName: r.appId ? (known.get(r.appId) ?? (isUuid(r.appId) ? null : r.appId)) : null,
    severity: r.severity, title: r.title, body: r.body, from: r.client || r.source, model: r.model, at: r.createdAt,
  }));
}

export type Dismissed = { id: string; title: string; appId: string | null; from: string };

// Marks one live note dismissed. Null when it doesn't exist or was already dismissed.
export async function dismiss(id: string, by: string, now: Date): Promise<Dismissed | null> {
  const [r] = await db().update(aiNotes).set({ dismissedAt: now, dismissedBy: by })
    .where(and(eq(aiNotes.id, id), isNull(aiNotes.dismissedAt)))
    .returning({ id: aiNotes.id, title: aiNotes.title, appId: aiNotes.appId, source: aiNotes.source, client: aiNotes.client });
  return r ? { id: r.id, title: r.title, appId: r.appId, from: r.client || r.source } : null;
}

// Dismiss all (owner 28 Oct): the notes the owner saw, by id, at most NOTES_MAX; one that was dismissed meanwhile is
// left alone. The number marked.
export async function dismissMany(ids: string[], by: string, now: Date): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db().update(aiNotes).set({ dismissedAt: now, dismissedBy: by })
    .where(and(inArray(aiNotes.id, ids.slice(0, NOTES_MAX)), isNull(aiNotes.dismissedAt)))
    .returning({ id: aiNotes.id });
  return rows.length;
}
