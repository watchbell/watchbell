"use server";

import { refresh } from "next/cache";
import { type ActionResult, type GuardMember, runGuarded } from "@/lib/action";
import { requireActionMember } from "@/lib/auth";
import { recordAction } from "@/lib/data/audit-db";
import { applyExternalAlerts, createSource, readSources, recentExternal, revokeSources, TEST_SUBJECT } from "@/lib/data/ingest-db";
import { deliverPending } from "@/lib/data/notify-db";
import { serverEnv } from "@/lib/env";
import { LIMITS, minutesText } from "@/lib/rate-limit";
import { limit } from "@/lib/rate-limit-db";
import { ingestUrl } from "@/lib/view/sources";

// Watchbell 1.8.6: Alerts › Sources (owners only; the demo has none). The token is shown once, in the response of the
// set-up; the audit line and the page only ever carry its 7-character prefix.
const deps = { requireActionMember };

async function quota(member: GuardMember): Promise<{ ok: false; error: string } | null> {
  const q = await limit(LIMITS.alertWrite, member.id);
  return q.allowed ? null : { ok: false, error: `Too many changes. Try again in ${minutesText(q.retryAfter)}.` };
}
async function audit(member: GuardMember, message: string) {
  await recordAction({ kind: "ok", message, resourceId: null, actorUserId: member.userId }).catch(() => console.warn("audit event failed"));
}
const enabledSource = async () => (await readSources()).find((s) => s.kind === "alertmanager" && s.enabled) ?? null;

// Set up, or replace: a new token; the old one stops working at once.
export async function setupSourceAction(): Promise<ActionResult<{ url: string; prefix: string }>> {
  return runGuarded("owner", async (member) => {
    const q = await quota(member);
    if (q) return q;
    const s = await createSource("alertmanager");
    await audit(member, `Alertmanager source set up (${s.prefix}…)`);
    refresh();
    return { ok: true, data: { url: ingestUrl(serverEnv().SITE_URL, s.token), prefix: s.prefix } };
  }, deps);
}

export async function revokeSourceAction(): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const q = await quota(member);
    if (q) return q;
    const src = await enabledSource();
    const n = await revokeSources("alertmanager");
    if (!n) return { ok: false, error: "There's no Alertmanager source to revoke." };
    await audit(member, `Alertmanager source revoked (${src?.tokenPrefix ?? "am_"}…${n > 1 ? ` and ${n - 1} more` : ""})`);
    refresh();
    return { ok: true, message: "Revoked. Alertmanager's posts now get 404." };
  }, deps);
}

// The same path as a real alert (rule, channels, silence), as info; the stale step closes it after 5 minutes.
export async function sendTestAlertAction(): Promise<ActionResult> {
  return runGuarded("owner", async (member) => {
    const q = await quota(member);
    if (q) return q;
    const src = await enabledSource();
    if (!src) return { ok: false, error: "Set up Alertmanager first." };
    const now = new Date();
    await applyExternalAlerts(src, [{
      subject: TEST_SUBJECT, status: "firing", severity: "info", title: "WatchbellTest",
      message: "A test alert from Alerts › Sources. It resolves by itself in about 5 minutes.",
      labels: { alertname: "WatchbellTest", source: "watchbell" }, startedAt: now,
    }], now);
    await deliverPending(now, Date.now() + 8_000).catch((e: unknown) => console.warn("test alert notices failed:", e instanceof Error ? e.name : "error"));
    await audit(member, "Alertmanager test alert sent");
    refresh();
    return { ok: true, message: "Test alert sent. It shows in Firing and resolves in about 5 minutes." };
  }, deps);
}

// The wizard's step 3 asks this every 5 seconds: has Alertmanager itself posted since the step opened? Only the route
// sets lastSeenAt, so the test button above can't make it say yes. Read-only, so no write quota.
export async function sourceStatusAction(sinceIso: string): Promise<ActionResult<{ received: boolean; title?: string }>> {
  return runGuarded<{ received: boolean; title?: string }>("owner", async () => {
    const since = typeof sinceIso === "string" ? Date.parse(sinceIso) : NaN;
    if (!Number.isFinite(since)) return { ok: false, error: "Something in that request wasn't valid." };
    const src = await enabledSource();
    const received = !!src?.lastSeenAt && src.lastSeenAt.getTime() > since;
    if (!received) return { ok: true, data: { received: false } };
    const [latest] = await recentExternal(1);
    return { ok: true, data: { received: true, ...(latest ? { title: latest.title } : {}) } };
  }, deps);
}
