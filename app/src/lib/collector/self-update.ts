import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { mode } from "@/lib/mode";
import { nodeCheckOff } from "@/lib/security/node-runtime";
import { fetchLatestVersion, LATEST_KEY, parseLatest, parseSeen, runningVersion, SEEN_KEY, type UpdateNotice, updateNotice } from "@/lib/self-update";

// Watchbell 1.2.3: runs with the 12-hourly "node" task, self-hosted only (the cloud edition is deployed from its own
// repository and has no npm version). One GET to registry.npmjs.org; WATCHBELL_NO_UPDATE_CHECK turns it off like the
// Node.js reads. The first run also records the running version as seen, so a first install shows no "What's new".

export async function taskSelfUpdate(now: Date, deadline: number, errors: string[], env: Record<string, string | undefined> = process.env, f?: typeof fetch): Promise<void> {
  const running = runningVersion(env);
  if (!running || mode(env) !== "selfhost" || nodeCheckOff(env).off) return;
  const left = deadline - Date.now();
  if (left < 1_000) return; // the next 12-hourly run asks
  const read = await fetchLatestVersion({ fetch: f, timeoutMs: Math.min(6_000, left) });
  if (!read.ok) errors.push(`update check: ${read.error}`);
  else {
    const value = { version: read.version, checkedAt: now.toISOString() };
    await db().insert(settings).values({ key: LATEST_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  }
  await db().insert(settings).values({ key: SEEN_KEY, value: { version: running } }).onConflictDoNothing({ target: settings.key });
}

// The owner's console banner (layout): null in the cloud edition, without a version, or with nothing to say.
export async function readUpdateNotice(env: Record<string, string | undefined> = process.env): Promise<UpdateNotice> {
  const running = runningVersion(env);
  if (!running || mode(env) !== "selfhost") return null;
  const rows = await db().select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [LATEST_KEY, SEEN_KEY])).limit(2);
  const value = (k: string) => rows.find((r) => r.key === k)?.value;
  return updateNotice({ running, latest: nodeCheckOff(env).off ? null : parseLatest(value(LATEST_KEY)), seen: parseSeen(value(SEEN_KEY)) });
}

// "Got it" on What's new: the running version is now the one seen.
export async function markVersionSeen(env: Record<string, string | undefined> = process.env): Promise<void> {
  const running = runningVersion(env);
  if (!running) return;
  const now = new Date();
  await db().insert(settings).values({ key: SEEN_KEY, value: { version: running } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { version: running }, updatedAt: now } });
}
