import "server-only";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { appSecurity, monitors, resources } from "@/db/schema";
import { mapLimit } from "@/lib/collector/http-check";
import { safeError } from "@/lib/collector/safe-error";
import { recordEvents } from "@/lib/data/events-write";
import { checkNextSecurity } from "@/lib/security/check";
import { securityEvent } from "@/lib/security/rules";
import type { SecurityRow } from "@/lib/security/types";
import type { FrameworkFact } from "@/lib/alerts/facts";
import { isUuid } from "@/lib/ids";
import { storedDomains } from "@/lib/domain-move";
import { appDomain } from "@/lib/view/format";
import { checkNowText } from "@/lib/view/security";
import { PAGE_ROWS } from "@/lib/view/windows";

// The Next.js security check's reads and writes (ops.app_security). Runs from the daily job, the collector's `security`
// task (every 6 hours and after a new production deployment, Watchbell 1.2.1) and Check now; pages read the row
// through listApps. Only console rows change; the app sites and OSV.dev are only read.

export const SECURITY_CONCURRENCY = 3;
// A check is only started when this much of the caller's budget is left; the rest are tried next time.
const MIN_START_MS = 3000;

type Target = { id: string; name: string; host: string; prev: SecurityRow | null };

export function toSecurityRow(r: typeof appSecurity.$inferSelect): SecurityRow {
  return { version: r.version, status: r.status, findings: Array.isArray(r.findings) ? r.findings : [], reason: r.reason, checkedAt: r.checkedAt };
}

// Watched apps (not gone), never checked first, then the longest-ago checked. The host is the one the console shows
// for the app: its stored primary domain (1.2.1), else its oldest monitor's, else <name>.vercel.app. `only`: just these apps; `first` (Watchbell 1.2.1, the
// apps marked after a production deploy): these lead the list; `skip` (fix round 1: a 6-hourly slot continuing over
// several minute runs): these are left out.
export type SecurityPick = { first?: readonly string[]; only?: readonly string[]; skip?: readonly string[] };
async function targets(pick: SecurityPick = {}): Promise<Target[]> {
  const only = pick.only;
  if (only && !only.length) return [];
  const first = pick.first ?? [];
  const skip = pick.skip ?? [];
  const rows = await db().select({ id: resources.id, name: resources.name, meta: resources.meta, sec: appSecurity }).from(resources)
    .leftJoin(appSecurity, eq(appSecurity.resourceId, resources.id))
    .where(and(
      eq(resources.kind, "app"), eq(resources.monitored, true), isNull(resources.goneAt), only ? inArray(resources.id, only) : undefined,
      skip.length ? notInArray(resources.id, [...skip]) : undefined,
    ))
    .orderBy(...(first.length ? [sql`case when ${inArray(resources.id, first)} then 0 else 1 end`] : []), sql`${appSecurity.checkedAt} asc nulls first`, resources.name)
    .limit(PAGE_ROWS.apps);
  if (!rows.length) return [];
  if (first.length) rows.sort((a, b) => Number(!first.includes(a.id)) - Number(!first.includes(b.id))); // stable: keeps the age order
  const mons = await db().select({ resourceId: monitors.resourceId, url: monitors.url }).from(monitors)
    .where(inArray(monitors.resourceId, rows.map((r) => r.id))).orderBy(monitors.createdAt).limit(PAGE_ROWS.monitors);
  return rows.map((r) => ({
    id: r.id, name: r.name, prev: r.sec ? toSecurityRow(r.sec) : null,
    // Watchbell 1.2.1: the domain production is served on (stored by Sync and the domains task) when known, so a monitor
    // still on an old domain doesn't send the check there.
    host: storedDomains(r.meta)?.primaryDomain ?? appDomain(r.name, mons.filter((m) => m.resourceId === r.id).map((m) => m.url)),
  }));
}

// Check now and the daily job can finish the same app at the same moment. Writes are serialised per app with a
// transaction-scoped advisory lock (it works through the transaction pooler), and everything is decided against the
// row as stored now, not the one read before the check: an older result never overwrites a newer one, the event
// compares with what is really there (no duplicate), and an unknown or failed result keeps the stored version and
// findings.
async function save(t: Target, next: SecurityRow): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app_security:${t.id}`}))`);
    const [cur] = await tx.select().from(appSecurity).where(eq(appSecurity.resourceId, t.id)).limit(1);
    const stored = cur ? toSecurityRow(cur) : null;
    if (stored && stored.checkedAt.getTime() >= next.checkedAt.getTime()) return;
    const row = next.status === "unknown" || next.status === "error"
      ? { ...next, version: stored ? stored.version : next.version, findings: stored ? stored.findings : next.findings }
      : next;
    const values = { framework: "next", version: row.version, status: row.status, findings: row.findings, reason: row.reason, checkedAt: row.checkedAt };
    await tx.insert(appSecurity).values({ resourceId: t.id, ...values }).onConflictDoUpdate({
      target: appSecurity.resourceId, set: values, setWhere: sql`${appSecurity.checkedAt} < excluded.checked_at`,
    });
    const ev = securityEvent(t.name, stored, row);
    if (ev) await recordEvents([{ type: "system", kind: ev.kind, message: ev.message, detail: ev.detail, resourceId: t.id, at: row.checkedAt, reason: ev.kind === "ok" ? "NextClean" : "NextVulnerable" }], tx);
  });
}

// The daily job's "security" step and the collector's `security` task: every watched app (or `pick`), three at a time,
// inside the caller's deadline. done: the apps whose check finished or failed (not those skipped for time); started: the
// apps whose check began, also one that then ran out of time (fix round 1: an attempt); listed: the apps it would check.
export type SecurityRun = { checked: number; skipped: number; failed: string[]; done: string[]; listed: string[]; started: string[] };
export async function runSecurityChecks(deadline: number, pick: SecurityPick = {}): Promise<SecurityRun> {
  const list = await targets(pick);
  let checked = 0;
  let skipped = 0;
  const failed: string[] = [];
  const done: string[] = [];
  const started: string[] = [];
  await mapLimit(list, SECURITY_CONCURRENCY, async (t) => {
    if (deadline - Date.now() < MIN_START_MS) {
      skipped++;
      return;
    }
    started.push(t.id);
    try {
      const next = await checkNextSecurity(t.host, t.prev, { deadline });
      if (!next) {
        skipped++;
        return;
      }
      await save(t, next);
      checked++;
      done.push(t.id);
    } catch (e) {
      failed.push(`${t.name}: ${safeError(e)}`);
      done.push(t.id);
    }
  });
  return { checked, skipped, failed, done, listed: list.map((t) => t.id), started };
}

export type SecurityDone =
  | { ok: true; message: string; passed: boolean; vulnerable: boolean; audit: { message: string; resourceId: string } }
  | { ok: false; error: string };

// App page → Security → Check now. 20 s leaves room for auth, the writes, the audit and the re-render inside the
// page's 30 s maxDuration.
export async function checkSecurityNow(appId: string, budgetMs = 20_000): Promise<SecurityDone> {
  const [t] = await targets({ only: [appId] });
  if (!t) return { ok: false, error: "That app is no longer in the console." };
  const next = await checkNextSecurity(t.host, t.prev, { deadline: Date.now() + budgetMs });
  if (!next) return { ok: false, error: "The check took too long. Try again in a minute." };
  await save(t, next);
  return {
    ok: true, message: checkNowText(t.name, next), passed: next.status === "ok" || next.status === "vulnerable", vulnerable: next.findings.length > 0,
    audit: { message: `Security check: ${t.name}`, resourceId: t.id },
  };
}

// Watchbell 1.2: the alert rule FrameworkVulnerable's facts, the stored check of these apps (one row each at most).
export async function frameworkFacts(appIds: string[]): Promise<FrameworkFact[]> {
  const ids = appIds.filter(isUuid);
  if (!ids.length) return [];
  const rows = await db().select().from(appSecurity).where(inArray(appSecurity.resourceId, ids)).limit(ids.length);
  return rows.map((r) => {
    const s = toSecurityRow(r);
    return { appId: r.resourceId, version: s.version, status: s.status, findings: s.findings };
  });
}
