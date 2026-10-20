import "server-only";
import { and, desc, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { aliasBook } from "@/lib/data/cached";
import { aiNotes } from "@/private/db/schema";
import { scrubText } from "./scrub";
import { resolveApp } from "./snapshot";

// GET /api/v1/advice?app=<name>: the portfolio advisor reads the latest AI notes written about one app (by an agent
// over MCP, submit_ai_note, R8). Owner ruling 13 Oct: periodic advice from Antigravity, not real-time chat.
export const ADVICE_NOTES = 5;

export type AdviceNote = { id: string; severity: string; title: string; body: string; source: string; model: string | null; createdAt: string };
export type Advice = { app: string; notes: AdviceNote[] };

// null when the app isn't a watched one. The note's app_id is the console id (T7 resolves a name to it); a note stored
// under the app's name is matched too, so either spelling works. Dismissed notes are never returned.
export async function adviceFor(key: string, now: Date): Promise<Advice | null> {
  const app = await resolveApp(key, now);
  if (!app) return null;
  const [rows, book] = await Promise.all([
    db().select({ id: aiNotes.id, severity: aiNotes.severity, title: aiNotes.title, body: aiNotes.body, source: aiNotes.source, model: aiNotes.model, createdAt: aiNotes.createdAt })
      .from(aiNotes).where(and(isNull(aiNotes.dismissedAt), inArray(aiNotes.appId, [app.id, app.name])))
      .orderBy(desc(aiNotes.createdAt)).limit(ADVICE_NOTES),
    aliasBook(),
  ]);
  return {
    app: app.name,
    notes: rows.map((r) => ({
      id: r.id, severity: r.severity, title: scrubText(r.title, book), body: scrubText(r.body, book), source: r.source, model: r.model,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
