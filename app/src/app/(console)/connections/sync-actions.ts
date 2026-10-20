"use server";

import { revalidatePath } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { updateTags } from "@/lib/cache/invalidate";
import { ALL_TAGS } from "@/lib/cache/tags";
import { readAliasBook } from "@/lib/data/aliases-db";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { saveSelection, type SyncRow, syncAccount } from "@/lib/sync-db";
import { dbAlias } from "@/lib/view/display-name";

type SyncData = { rows: SyncRow[]; skippedTeams: string[]; overLimit: string | null };

const deps = { requireActionMember };
const UUID = /^[0-9a-f-]{36}$/i;
const INVALID = "Something in that request wasn't valid.";

export async function syncNow(accountId: string): Promise<ActionResult<SyncData>> {
  return runGuarded("owner", async (member): Promise<ActionResult<SyncData>> => {
    if (typeof accountId !== "string" || !UUID.test(accountId)) return { ok: false, error: INVALID };
    const quota = await limit(LIMITS.sync, member.id);
    if (!quota.allowed) return { ok: false, error: `Too many syncs. Try again in ${minutesText(quota.retryAfter)}.` };
    const r = await syncAccount(accountId);
    revalidatePath("/connections");
    // Sync renames, adds and marks gone resources of any kind (apps, databases, zones): every cached list (perf P3).
    updateTags(ALL_TAGS);
    if (!r.ok) return { ok: false, error: r.error };
    // Privacy: each database row carries its alias, read after Sync wrote the rows (the page's letters predate them).
    const isDb = (x: SyncRow) => x.badge === "db" || x.badge === "fs";
    const book = r.rows.some(isDb) ? await readAliasBook() : null;
    const rows = book ? r.rows.map((x) => (isDb(x) ? { ...x, alias: dbAlias(book, x.id) } : x)) : r.rows;
    return { ok: true, data: { rows, skippedTeams: r.skippedTeams, overLimit: r.overLimit } };
  }, deps);
}

export async function saveSyncSelection(accountId: string, selectedIds: string[], watchNew: boolean): Promise<ActionResult<{ overLimit: string | null }>> {
  return runGuarded("owner", async (): Promise<ActionResult<{ overLimit: string | null }>> => {
    if (typeof accountId !== "string" || !UUID.test(accountId) || !Array.isArray(selectedIds)) return { ok: false, error: INVALID };
    const ids = selectedIds.filter((id) => typeof id === "string" && UUID.test(id)).slice(0, 500);
    const r = await saveSelection(accountId, ids, watchNew === true);
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath("/connections");
    revalidatePath("/welcome");
    updateTags(ALL_TAGS); // what is watched changed
    return { ok: true, message: `Watching ${r.on} of ${r.total} resources. Checks start on the next collector run.`, data: { overLimit: r.overLimit } };
  }, deps);
}
