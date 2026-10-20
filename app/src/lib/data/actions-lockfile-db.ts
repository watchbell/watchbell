import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { ACTIONS_REPO_SETTING, ACTIONS_WAIT_MS, isActionsRepo, lockfilePayload, parseActionsSetting } from "@/lib/deps/actions-lockfile";
import { dispatchLockfile } from "@/lib/providers/github-write";

// Lockfile updates through GitHub Actions (lib/deps/actions-lockfile.ts). The setting holds the owner's actions
// repository; each dispatch is remembered per PR branch so the merge watcher waits for it instead of stopping on CI.
const SENT_KEY = "deps.lockfileDispatched";

export async function readActionsRepo(): Promise<string | null> {
  const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, ACTIONS_REPO_SETTING)).limit(1);
  return parseActionsSetting(row?.value).repo;
}

export async function saveActionsRepo(repo: string | null): Promise<void> {
  if (repo !== null && !isActionsRepo(repo)) throw new Error("not a repository");
  const value = { repo };
  await db().insert(settings).values({ key: ACTIONS_REPO_SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

// Never throws: { sent } or why not.
export async function dispatchLockfileUpdate(token: string, o: { repo: string; branch: string; lockfilePath: string | null; prNumber: number }, now = new Date()): Promise<{ sent: boolean; why?: string }> {
  try {
    const actions = await readActionsRepo();
    if (!actions) return { sent: false, why: "no actions repository" };
    const payload = lockfilePayload(o);
    if (!payload) return { sent: false, why: "invalid" };
    const r = await dispatchLockfile(token, actions, payload);
    if (!r.ok) return { sent: false, why: r.error };
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, SENT_KEY)).limit(1);
    const prev = (row?.value && typeof row.value === "object" ? row.value : {}) as Record<string, string>;
    // keep only the last day's entries
    const kept = Object.fromEntries(Object.entries(prev).filter(([, at]) => now.getTime() - Date.parse(at) < 86_400_000));
    const value = { ...kept, [`${o.repo}#${o.branch}`]: now.toISOString() };
    await db().insert(settings).values({ key: SENT_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
    return { sent: true };
  } catch (e) {
    console.warn("deps: lockfile dispatch failed:", e instanceof Error ? e.name : "error");
    return { sent: false, why: "error" };
  }
}

// The watcher: a lockfile update for this PR branch was dispatched within ACTIONS_WAIT_MS. Never throws.
export async function actionsLockfilePending(repo: string, branch: string, now = new Date()): Promise<boolean> {
  try {
    const [row] = await db().select({ value: settings.value }).from(settings).where(eq(settings.key, SENT_KEY)).limit(1);
    const at = (row?.value as Record<string, string> | undefined)?.[`${repo}#${branch}`];
    return !!at && now.getTime() - Date.parse(at) < ACTIONS_WAIT_MS;
  } catch {
    return false;
  }
}
