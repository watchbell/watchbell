"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { monthLabel, monthOf } from "@/lib/backup/content";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_TTL_S, sealTicket } from "@/lib/backup/connect";
import { authUrl, DRIVE_ENV_MISSING, driveEnv, newState, pkcePair, redirectUri } from "@/lib/backup/google-oauth";
import { runBackup } from "@/lib/backup/run";
import { recordAction } from "@/lib/data/audit-db";
import { removeDriveAccount } from "@/lib/data/backup-db";
import { serverEnv } from "@/lib/env";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

const deps = { requireActionMember };
// "Back up now" stops starting Drive calls after 45 s; the page allows 60 s (maxDuration).
const BACKUP_NOW_MS = 45_000;

// B1: start the Drive connect. The state and the PKCE verifier go into a sealed, httpOnly cookie that only
// /auth/google/* receives; the browser is sent to Google's consent page.
export async function startDriveConnect(): Promise<ActionResult<{ url: string }>> {
  return runGuarded("owner", async (member): Promise<ActionResult<{ url: string }>> => {
    const env = driveEnv();
    if (!env) return { ok: false, error: DRIVE_ENV_MISSING };
    const { SITE_URL, OPS_ENCRYPTION_KEY } = serverEnv();
    const state = newState();
    const { verifier, challenge } = pkcePair();
    (await cookies()).set(OAUTH_COOKIE, sealTicket({ state, verifier, memberId: member.id, exp: Date.now() + OAUTH_TTL_S * 1000 }, OPS_ENCRYPTION_KEY), {
      httpOnly: true, secure: SITE_URL.startsWith("https://"), sameSite: "lax", path: OAUTH_COOKIE_PATH, maxAge: OAUTH_TTL_S,
    });
    return { ok: true, data: { url: authUrl(env, { state, challenge, redirectUri: redirectUri(SITE_URL) }) } };
  }, deps);
}

// Forgets the connection in the console only. Google keeps listing Watchbell under the account's third-party access
// until the owner removes it there; the backups already in Drive stay.
export async function disconnectDrive(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const removed = await removeDriveAccount();
    revalidatePath("/backups");
    revalidatePath("/connections");
    if (!removed) return { ok: false, error: "Google Drive isn't connected." };
    await recordAction({ kind: "ok", message: "Google Drive disconnected", resourceId: null, actorUserId: member.userId }).catch(() => undefined);
    return { ok: true, message: "Google Drive disconnected. The backups already in your Drive stay; remove Watchbell's access in your Google Account if you want." };
  }, deps);
}

// B4: the current month so far, as a partial backup (the 1st overwrites it with the full month).
export async function backUpNow(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    const quota = await limit(LIMITS.backupNow, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many backups. Try again in ${minutesText(quota.retryAfter)}.` };
    const now = new Date();
    const month = monthOf(now);
    const r = await runBackup({ month, partial: true, now, deadline: Date.now() + BACKUP_NOW_MS });
    if (!r.ok && (r.kind === "env" || r.kind === "not-connected")) return { ok: false, error: r.error };
    await recordAction({
      kind: r.ok ? "ok" : "err", message: `Back up now · ${monthLabel(month)}`, resourceId: null, actorUserId: member.userId, ...(r.ok ? {} : { detail: r.error.slice(0, 200) }),
    }).catch(() => undefined);
    revalidatePath("/backups");
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
  }, deps);
}
