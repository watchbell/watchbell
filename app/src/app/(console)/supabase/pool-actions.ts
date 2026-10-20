"use server";

import { refresh } from "next/cache";
import { type ActionResult, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { guardPool } from "@/lib/data/pool-guard";
import { isCloud } from "@/lib/mode";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";

// The Supabase page's "Close idle connections" (owner 16 Oct): closes every Watchbell pooler connection idle for 5 s or
// more (never a busy one, never another role's). Owner only, the console-row write quota, audited.
const deps = { requireActionMember };

export async function closeIdleConnections(): Promise<ActionResult> {
  return runGuarded("owner", async (member): Promise<ActionResult> => {
    if (!isCloud()) return { ok: false, error: "Not available in this mode." };
    const q = await limit(LIMITS.monitorWrite, member.id);
    if (!q.allowed) return { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
    const r = await guardPool(1, 5);
    await recordAction({ kind: "ok", message: `Closed ${r.trimmed} idle database connection${r.trimmed === 1 ? "" : "s"} (pool ${r.total}/15)`, resourceId: null, actorUserId: member.userId })
      .catch(() => console.warn("audit event failed"));
    refresh();
    return { ok: true, message: `Closed ${r.trimmed} idle connection${r.trimmed === 1 ? "" : "s"}.` };
  }, deps);
}

// For a plain <form action>: the result shows through the refreshed card.
export async function closeIdleForm(): Promise<void> {
  await closeIdleConnections();
}
