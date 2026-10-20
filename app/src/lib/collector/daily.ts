import "server-only";
import { and, eq, gte, inArray, isNotNull, lt, max } from "drizzle-orm";
import { db } from "@/db/client";
import { expireTags } from "@/lib/cache/invalidate";
import { ALL_TAGS } from "@/lib/cache/tags";
import { accounts, alerts, checks, collectorRuns, deployments, events, recommendationDismissals, rollupsHourly, storedLogs } from "@/db/schema";
import { monthlyBackupStep } from "@/lib/backup/run";
import { runAdvisor } from "@/lib/data/advisor-db";
import { DEPS_HARD_STOP_MS, DEPS_STEP_MS, depsDailyStep } from "@/lib/data/deps-db";
import { githubDailyStep } from "@/lib/data/github-db";
import { recordEvents } from "@/lib/data/events-write";
import { recordPing } from "@/lib/data/heartbeats-db";
import { runKeepAlive } from "@/lib/data/keep-active-db";
import { tokenFromSetting } from "@/lib/heartbeat";
import { runSecurityChecks } from "@/lib/data/security-db";
import { dailyDeadline } from "@/lib/security/check";
import { SYNC_PROVIDERS } from "@/lib/sync";
import { syncAccount } from "@/lib/sync-db";
import { taskDatabasesDaily } from "./db-tasks";
import { RETENTION_DAYS } from "./retention";
import { readRetentionDays } from "@/lib/data/settings-db";
import { hourStart, rollup, rollupSince } from "./rollup";
import type { RunSummary } from "./run";
import { safeError } from "./safe-error";

const DAY = 86_400_000;
// The sync step starts no new account after 25 s; databases (up to 15 s, ends by 50 s) and security (ends by 55 s)
// follow, all inside /api/daily's maxDuration of 60 s.
export const SYNC_STOP_MS = 25_000;
// Stage 7 (B4): the monthly Google Drive backup starts no new Drive call after 20 s into the run. Most days it only reads
// whether a month is due; on the 1st (and on a retry) it writes the month before retention can delete any of it.
export const BACKUP_STOP_MS = 20_000;
export const GITHUB_STEP_MS = 6_000;

// Picks up where the last rollup left off, so a missed day (or a week of them) is filled in on the next run.
async function rollupRecent(now: Date): Promise<void> {
  const [latest] = await db().select({ hour: max(rollupsHourly.hour) }).from(rollupsHourly);
  const since = rollupSince(latest?.hour ?? null, now);
  // In time order, so the hours are written oldest first: a run killed half-way leaves the latest rolled-up hour at
  // the edge of what was done, and the next run resumes from there instead of skipping the hours in between.
  const rows = await db().select().from(checks).where(and(gte(checks.at, since), lt(checks.at, hourStart(now)))).orderBy(checks.at);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.monitorId}|${hourStart(r.at).toISOString()}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, list] of groups) {
    const [monitorId, hour] = k.split("|");
    // U5: the rows carry in_maintenance, so `maintenance` is written (and rewritten on conflict) with the rest.
    const v = rollup(list);
    await db().insert(rollupsHourly).values({ monitorId, hour: new Date(hour), ...v })
      .onConflictDoUpdate({ target: [rollupsHourly.monitorId, rollupsHourly.hour], set: v });
  }
}

// Deletes only the console's own history tables; nothing is ever deleted at a provider.
// Stage 7 (B6): the days are the Owner's choices in Settings → Retention; an unreadable setting keeps the defaults.
async function retention(now: Date): Promise<void> {
  const days = await readRetentionDays().catch(() => RETENTION_DAYS);
  await db().delete(checks).where(lt(checks.at, new Date(now.getTime() - days.checks * DAY)));
  await db().delete(rollupsHourly).where(lt(rollupsHourly.hour, new Date(now.getTime() - days.rollupsHourly * DAY)));
  await db().delete(deployments).where(and(
    lt(deployments.createdAtProvider, new Date(now.getTime() - days.deployments * DAY)),
    eq(deployments.isCurrent, false),
    eq(deployments.isPreviousProduction, false),
  ));
  await db().delete(events).where(lt(events.at, new Date(now.getTime() - days.events * DAY)));
  await db().delete(alerts).where(and(isNotNull(alerts.resolvedAt), lt(alerts.resolvedAt, new Date(now.getTime() - days.alerts * DAY))));
  await db().delete(collectorRuns).where(lt(collectorRuns.startedAt, new Date(now.getTime() - days.collectorRuns * DAY)));
  await db().delete(storedLogs).where(lt(storedLogs.at, new Date(now.getTime() - days.storedLogs * DAY)));
  // An Advisor dismissal only matters for 30 days; a key that never comes back would sit here for ever.
  await db().delete(recommendationDismissals).where(lt(recommendationDismissals.dismissedAt, new Date(now.getTime() - days.recommendationDismissals * DAY)));
}

// Vercel Cron, once a day (03:00 WIB): rollups, the monthly backup when one is due, retention, a sync of every account, the Next.js security check and the Advisor.
export async function runDaily(): Promise<RunSummary> {
  const started = new Date();
  const [run] = await db().insert(collectorRuns).values({ startedAt: started, trigger: "vercel_cron" }).returning({ id: collectorRuns.id });
  const errors: string[] = [];
  const steps: [string, () => Promise<void>][] = [
    ["rollups", () => rollupRecent(started)],
    // B4: before retention, so the month's deployments and events are all still there. Never throws.
    ["backup", async () => {
      const problem = await monthlyBackupStep(started, started.getTime() + BACKUP_STOP_MS);
      if (problem) errors.push(`backup: ${problem}`);
    }],
    ["retention", () => retention(started)],
    ["sync", async () => {
      // Every provider that has a Sync (Vercel apps, database projects, Cloudflare zones). No new account sync starts
      // after SYNC_STOP_MS, so the database and security steps keep their share of the 60 s; the rest syncs tomorrow.
      const list = await db().select({ id: accounts.id, label: accounts.label, provider: accounts.provider }).from(accounts).where(inArray(accounts.provider, SYNC_PROVIDERS));
      for (const [i, a] of list.entries()) {
        if (Date.now() > started.getTime() + SYNC_STOP_MS) {
          errors.push(`sync: ${list.length - i} account${list.length - i > 1 ? "s" : ""} left for the next run, time budget used`);
          break;
        }
        const r = await syncAccount(a.id);
        if (!r.ok) errors.push(`sync ${a.provider}/${a.label}: ${r.error}`);
        else {
          if (r.skippedTeams.length) errors.push(`sync ${a.provider}/${a.label}: skipped teams ${r.skippedTeams.join(", ")} (no access)`);
          if (r.overLimit) errors.push(`sync ${a.provider}/${a.label}: ${r.overLimit}`);
        }
      }
    }],
    // Stage 7 (B7): the GitHub connection's repositories, Vercel's repo links and the linked repos' Actions status, in
    // at most 6 s and never past 35 s into the run. Nothing without a GitHub connection.
    ["github", async () => {
      const problem = await githubDailyStep(Math.min(Date.now() + GITHUB_STEP_MS, started.getTime() + 35_000));
      if (problem) errors.push(`github: ${problem}`);
    }],
    // Stage 9 slice 5: the linked repositories' dependency (CVE) scan, in at most 12 s and never past 40 s into the run.
    // An unchanged lockfile costs one GitHub GET; the repositories that don't fit wait for tomorrow (oldest scan first).
    ["deps", async () => {
      const problem = await depsDailyStep(Math.min(Date.now() + DEPS_STEP_MS, started.getTime() + DEPS_HARD_STOP_MS));
      if (problem) errors.push(`deps: ${problem}`);
    }],
    // Supabase sizes (only projects already in use, D1) and Firebase Auth user counts, within 15 s.
    ["databases", () => taskDatabasesDaily({ now: started, deadline: Math.min(Date.now() + 15_000, started.getTime() + 50_000), errors })],
    // Stage 6 A8: the owner's Keep active (one `select 1` per kept project idle for 5 days), within 5 s. Never throws.
    ["keep-active", () => runKeepAlive(started, Math.min(Date.now() + 5_000, started.getTime() + 50_000), errors)],
    // Next.js version of every watched app vs OSV.dev. Apps that don't fit the time left wait for the next run
    // (oldest check first), which is not an error.
    ["security", async () => {
      const r = await runSecurityChecks(dailyDeadline(started.getTime(), Date.now()));
      for (const f of r.failed) errors.push(`security ${f}`);
    }],
    // R3: the Advisor's hygiene items from what the steps above just wrote. Console rows only; nothing is cached, so
    // there is no tag to expire (the pages read ops.settings "advisor.latest" and the dismissals).
    ["advisor", async () => { await runAdvisor(started); }],
  ];
  const done: string[] = [];
  try {
    for (const [name, fn] of steps) {
      try {
        await fn();
        done.push(name);
      } catch (e) {
        errors.push(`${name}: ${safeError(e)}`);
      }
    }
    await recordEvents([{ type: "system", kind: errors.length ? "warn" : "info", message: errors.length ? "Daily jobs finished with problems" : "Daily jobs finished", detail: "Rollups, the monthly backup when due, retention, a sync of every account, database sizes, the Next.js security check and the Advisor", resourceId: null }]);
  } catch (e) {
    errors.push(`events: ${safeError(e)}`);
  } finally {
    // The sync renames, adds and marks gone resources of every kind, and the databases step writes sizes and user
    // counts: every cached list is expired (perf P3), whatever finished.
    expireTags(ALL_TAGS);
    // the run row is always finished, so it never shows as running forever
    await db().update(collectorRuns).set({ finishedAt: new Date(), ok: errors.length === 0, errorSummary: errors.join("\n").slice(0, 2000) || null, durationMs: Date.now() - started.getTime(), tasks: done })
      .where(eq(collectorRuns.id, run.id)).catch(() => undefined);
  }
  await selfHeartbeat(errors.length > 0);
  const durationMs = Date.now() - started.getTime();
  return { skipped: false, ok: errors.length === 0, tasks: done, checks: 0, durationMs, errors };
}

// U3: the console's own daily job pings its own heartbeat (made on the console's app, period 1 day, grace 6 h; its
// token in DAILY_HEARTBEAT_TOKEN), so a daily run that never happens shows up like any other missed job. Recorded
// directly, no HTTP round trip. A ping that can't be written is not the daily run's failure.
// 15 Oct: it never pinged although the run was fine, and said nothing. The setting is now read leniently
// (tokenFromSetting) and every way it can miss is logged, never with the value.
async function selfHeartbeat(failed: boolean): Promise<void> {
  const raw = process.env.DAILY_HEARTBEAT_TOKEN;
  if (!raw) return; // not set up: nothing to ping
  const token = tokenFromSetting(raw);
  if (!token) {
    console.warn("daily heartbeat: DAILY_HEARTBEAT_TOKEN holds no single hb_ token; set it to the heartbeat's token");
    return;
  }
  const r = await recordPing(token, failed ? "fail" : "ok", new Date()).catch((e: unknown) => {
    console.warn("daily heartbeat: the ping couldn't be stored:", e instanceof Error ? e.name : "error");
    return null;
  });
  if (r?.status === "unknown") console.warn("daily heartbeat: DAILY_HEARTBEAT_TOKEN matches no heartbeat monitor (was it regenerated?)");
  else if (r?.status === "limited") console.warn("daily heartbeat: the ping was rate limited");
}
