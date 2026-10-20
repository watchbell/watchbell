"use server";

import { redirect } from "next/navigation";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { updateTags } from "@/lib/cache/invalidate";
import { TAG } from "@/lib/cache/tags";
import { removeApp } from "@/lib/data/apps-db";
import { isUuid } from "@/lib/ids";

// Owner only, like the Sync selection it undoes (spec §12). Console rows only; the Vercel project isn't touched.
// On success this redirects to the list (a refresh of the removed app's page would 404), so it only ever returns errors.
export async function removeAppFromConsole(appId: string): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isUuid(appId)) return { ok: false, error: "Something in that request wasn't valid." };
    const r = await removeApp(appId, member.userId);
    if (!r.ok) return { ok: false, error: r.error };
    // Its domains and its "Used by" entries on the database pages go with it (perf P3).
    updateTags([TAG.supabase, TAG.neon, TAG.firebase, TAG.domains]);
    redirect("/apps"); // runGuarded rethrows it for Next.js
  }, { requireActionMember }, "local");
}
