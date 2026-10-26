import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import {
  fetchNodeAdvisories, mergeNodeRead, nodeCheckOff, NODE_SETTINGS_KEY, NODE_TIMEOUT_MS, parseNodeAdvisories, type NodeAdvisories,
} from "@/lib/security/node-runtime";

// Watchbell 1.2.2 (D20): the 12-hourly "node" task. Two GETs (nodejs.org/dist/index.json and endoflife.date's nodejs
// cycles), cut to what is left of the run like `eol`, and one settings row. A failed read keeps the last good data
// and records why, so the Settings line says "unknown" instead of "ok" until a read succeeds again.
// WATCHBELL_NO_UPDATE_CHECK turns the reads off (fix round 1, I1): the task then does nothing and counts as run.

export async function readNodeAdvisories(): Promise<NodeAdvisories | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, NODE_SETTINGS_KEY)).limit(1);
  return row ? parseNodeAdvisories(row.value) : null;
}

export async function taskNode(now: Date, deadline: number, errors: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  if (nodeCheckOff(env).off) return;
  const left = deadline - Date.now();
  if (left < 1_000) throw new Error("skipped, time budget used"); // not marked as run: due again next run
  const read = await fetchNodeAdvisories({ timeoutMs: Math.min(NODE_TIMEOUT_MS, left) });
  // Fix round 1 (M2): the previous row is read after the fetch, so the fetch gets all the time `left` measured.
  const prev = await readNodeAdvisories();
  if (read.indexError) errors.push(`node: ${read.indexError}`);
  if (read.cyclesError) errors.push(`node: ${read.cyclesError}`);
  const value = mergeNodeRead(prev, read, now);
  await db().insert(settings).values({ key: NODE_SETTINGS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}
