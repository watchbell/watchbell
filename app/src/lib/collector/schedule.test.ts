import { describe, expect, it } from "vitest";
import {
  activeTasks, PROTECT_TASKS, protectOnly, ALERTS_RESERVE_MS, BUDGET_MS, CATCH_UP_PER_RUN, checkTimeout, dueTasks, OFFSETS, POST_TASKS, recheckable, slotStart, TASK_SECTION, type TaskName, TASKS, taskFits,
  TASK_ANY_SECTION, withAfterDeploy,
} from "./schedule";

const now = new Date("2026-10-12T10:00:01Z");
const ago = (s: number, from = now) => new Date(from.getTime() - s * 1000).toISOString();
const at = (iso: string) => new Date(iso);

const MINUTE = ["heartbeats", "checks", "vercel", "alerts"];
const ORDER = ["heartbeats", "checks", "vercel", "supabase", "supabaseUsage", "neon", "firebase", "firebaseUsage", "extraDbs", "cloudflare", "domains", "tls", "rdap", "eol", "status", "logs", "pageviews", "security", "alerts", "digest"];
const SLOW = ORDER.filter((t) => !MINUTE.includes(t)) as TaskName[];
// Every task ran in its current slot (or, for minute tasks, a second ago).
const fresh = (when: Date) => Object.fromEntries(ORDER.map((t) => [t, MINUTE.includes(t) ? ago(1, when) : new Date(slotStart(t as TaskName, when)).toISOString()]));
const slowOnly = (list: string[]) => list.filter((t) => !MINUTE.includes(t));

// Runs the scheduler once a minute (at :01, every task finishing) and returns what each run started.
function simulate(from: Date, minutes: number, lastRun: Partial<Record<TaskName, string>> = {}) {
  const runs: { at: Date; due: TaskName[] }[] = [];
  for (let i = 0; i < minutes; i++) {
    const t = new Date(from.getTime() + i * 60_000);
    const due = dueTasks(lastRun, t, false);
    for (const task of due) lastRun[task] = t.toISOString();
    runs.push({ at: t, due });
  }
  return runs;
}

describe("TASKS", () => {
  it("runs heartbeats first (final review I1), then the stage 3, 4 and 5 tasks in one order, with alerts and digest last", () => {
    expect(Object.keys(TASKS)).toEqual(ORDER);
    expect(POST_TASKS).toEqual(["alerts", "digest"]);
    expect(TASKS).toMatchObject({ checks: 60, heartbeats: 60, vercel: 60, alerts: 60, status: 300, logs: 300, pageviews: 1800, digest: 300, supabaseUsage: 3600, cloudflare: 3600, domains: 21_600, eol: 86_400 });
  });
  // Watchbell 1.2.1 (owner 23 Oct): the security check (Next.js versions and the dependency scan) every 6 hours, last of
  // the main tasks so it only takes the time the others leave.
  it("runs the security check every 6 hours at 04:36, 10:36, 16:36 and 22:36 UTC, right before the alert rules", () => {
    expect(TASKS.security).toBe(21_600);
    expect(OFFSETS.security).toBe(276 * 60);
    expect(ORDER.indexOf("security")).toBe(ORDER.indexOf("alerts") - 1);
    const hourly = (Object.keys(TASKS) as TaskName[]).filter((t) => TASKS[t] === 3600 || TASKS[t] === 1800).map((t) => (OFFSETS[t]! / 60) % 60);
    expect(hourly).not.toContain(36);
    // Fix round 1: room for a Next.js check (3 s) and two repository scans (2 × 4 s), else deferred to the next run.
    expect(taskFits("security", 20_000, 9_500)).toBe(false);
    expect(taskFits("security", 20_000, 9_000)).toBe(true);
  });
  it("runs page views every 30 minutes at :27 and :57, in a minute no hourly task uses", () => {
    expect(TASKS.pageviews).toBe(1800);
    expect(OFFSETS.pageviews).toBe(27 * 60);
    const hourly = (Object.keys(TASKS) as TaskName[]).filter((t) => TASKS[t] === 3600).map((t) => (OFFSETS[t]! / 60) % 30);
    expect(hourly).not.toContain(27);
  });
  it("gives every slower task an offset inside its interval", () => {
    for (const t of SLOW) {
      expect(OFFSETS[t]).toBeDefined();
      expect(OFFSETS[t]!).toBeLessThan(TASKS[t]);
    }
  });
});

describe("dueTasks", () => {
  it("runs the minute tasks every run, with 10 s of slack", () => {
    expect(dueTasks({ ...fresh(now), checks: ago(30), vercel: ago(56) }, now, false)).toEqual(["vercel"]);
    expect(dueTasks({ ...fresh(now), checks: ago(56), alerts: ago(56) }, now, false)).toEqual(["checks", "alerts"]);
  });
  it("still runs the minute tasks when cron fires 54 s after a late run (13 Oct 03:45:13 → 03:46:07)", () => {
    expect(dueTasks({ ...fresh(now), checks: ago(54), vercel: ago(54), alerts: ago(54) }, now, false)).toEqual(["checks", "vercel", "alerts"]);
    expect(dueTasks({ ...fresh(now), checks: ago(49) }, now, false)).toEqual([]);
  });
  it("runs a slower task once in its own minute of each interval", () => {
    // 10:00 is the :x0 minute: Supabase status (and the digest check) are due, the others ran in their own slots.
    const last = { ...fresh(now), supabase: ago(300), digest: ago(300) };
    expect(slowOnly(dueTasks(last, now, false))).toEqual(["supabase", "digest"]);
    // The next minute neither is due again, Neon's :x1 is.
    const next = at("2026-10-12T10:01:01Z");
    expect(slowOnly(dueTasks({ ...last, supabase: now.toISOString(), digest: now.toISOString(), neon: ago(300, next) }, next, false))).toEqual(["neon"]);
  });
  it("runs the hourly reads at their own minute: Cloudflare at :33, not at :32", () => {
    const t = at("2026-10-12T10:33:01Z");
    expect(slowOnly(dueTasks({ ...fresh(t), cloudflare: "2026-10-12T09:33:01Z" }, t, false))).toContain("cloudflare");
    const before = at("2026-10-12T10:32:01Z");
    expect(slowOnly(dueTasks({ ...fresh(before), cloudflare: "2026-10-12T09:33:01Z" }, before, false))).not.toContain("cloudflare");
  });
  it("counts a run a few seconds early (cron jitter) for the coming minute, and doesn't repeat it a minute later", () => {
    const early = at("2026-10-12T10:32:57Z");
    const last = { ...fresh(early), cloudflare: "2026-10-12T09:33:01Z" };
    expect(dueTasks(last, early, false)).toContain("cloudflare");
    const later = at("2026-10-12T10:33:57Z");
    expect(dueTasks({ ...last, cloudflare: early.toISOString() }, later, false)).not.toContain("cloudflare");
  });
  it("forces only the minute tasks on a manual or watchdog run; slower reads keep their slots", () => {
    expect(dueTasks(fresh(now), now, true)).toEqual(MINUTE);
  });
  it("a forced run still does a slower task whose slot is due, like a scheduled run", () => {
    expect(dueTasks({ ...fresh(now), supabase: ago(300) }, now, true)).toEqual(["heartbeats", "checks", "vercel", "supabase", "alerts"]);
  });
});

describe("dueTasks: spreading the first runs and catch-ups", () => {
  it("starts at most two never-run slower tasks per run, in TASKS order", () => {
    expect(dueTasks({}, now, false)).toEqual(["heartbeats", "checks", "vercel", "supabase", "supabaseUsage", "alerts"]);
    expect(CATCH_UP_PER_RUN).toBe(2);
  });
  it("after a deploy (all fourteen slower tasks new) every task has run within seven minutes, never more than two late ones a run", () => {
    const runs = simulate(at("2026-10-12T10:17:01Z"), 10);
    const firstRun = new Map<TaskName, number>();
    runs.forEach((r, i) => r.due.forEach((t) => firstRun.has(t) || firstRun.set(t, i)));
    for (const t of ORDER as TaskName[]) expect(firstRun.get(t), t).toBeLessThanOrEqual(7);
    for (const r of runs) expect(slowOnly(r.due).length).toBeLessThanOrEqual(CATCH_UP_PER_RUN + 2);
  });
  it("after an outage the missed slots are caught up two at a time, not all at once", () => {
    const t = at("2026-10-12T14:20:01Z");
    const last = Object.fromEntries(ORDER.map((x) => [x, "2026-10-12T10:00:01Z"]));
    const due = slowOnly(dueTasks(last, t, false));
    // On time: supabase and digest (:20 is their minute). Late: the first two in TASKS order.
    expect(due).toEqual(["supabase", "supabaseUsage", "neon", "digest"]);
  });
  it("steady state: at most two slower tasks in any minute, and the expected runs per day", () => {
    const runs = simulate(at("2026-10-11T00:00:01Z"), 2 * 1440);
    const day2 = runs.slice(1440);
    expect(Math.max(...day2.map((r) => slowOnly(r.due).length))).toBe(2);
    const count = (t: string) => day2.filter((r) => r.due.includes(t as TaskName)).length;
    expect(Object.fromEntries(ORDER.map((t) => [t, count(t)]))).toEqual({
      checks: 1440, heartbeats: 1440, vercel: 1440, alerts: 1440, supabase: 288, neon: 288, firebase: 288, status: 288, logs: 288, pageviews: 48, digest: 288,
      supabaseUsage: 24, firebaseUsage: 24, extraDbs: 24, cloudflare: 24, tls: 24, rdap: 24, domains: 4, eol: 1, security: 4,
    });
    expect(day2.filter((r) => r.due.includes("security")).map((r) => r.at.toISOString().slice(11, 16))).toEqual(["04:36", "10:36", "16:36", "22:36"]);
    // eol at 03:46 UTC, domains at 01:28, 07:28, 13:28, 19:28 UTC.
    expect(day2.filter((r) => r.due.includes("eol")).map((r) => r.at.toISOString())).toEqual(["2026-10-12T03:46:01.000Z"]);
    expect(day2.filter((r) => r.due.includes("domains")).map((r) => r.at.toISOString().slice(11, 16))).toEqual(["01:28", "07:28", "13:28", "19:28"]);
  });
});

// Watchbell 1.2.1: a new production deployment (marked by the Vercel task) starts the security task in the next run,
// even outside its 6-hourly slot ("early": only the marked apps, and its slot is kept).
describe("withAfterDeploy", () => {
  const minute = ["heartbeats", "checks", "vercel", "alerts"] as TaskName[];
  it("adds the security task before the alert rules when an app is marked and the task isn't due", () => {
    expect(withAfterDeploy(minute, true)).toEqual({ due: ["heartbeats", "checks", "vercel", "security", "alerts"], early: true });
    expect(withAfterDeploy(["checks", "alerts", "digest"], true).due).toEqual(["checks", "security", "alerts", "digest"]);
    expect(withAfterDeploy(["checks"], true).due).toEqual(["checks", "security"]);
  });
  it("changes nothing without a mark, or when the 6-hourly run is due anyway (it checks the marked apps first)", () => {
    expect(withAfterDeploy(minute, false)).toEqual({ due: minute, early: false });
    const due = ["checks", "security", "alerts"] as TaskName[];
    expect(withAfterDeploy(due, true)).toEqual({ due, early: false });
  });
  it("respects the sections: nothing while Hosting and DevOps are both off", () => {
    expect(withAfterDeploy(minute, true, new Set(["hosting", "devops"] as const))).toEqual({ due: minute, early: false });
    expect(withAfterDeploy(minute, true, new Set(["devops"] as const)).early).toBe(true);
  });
});

describe("checkTimeout", () => {
  const t = now.getTime();
  it("keeps the monitor's own timeout while the run has more time left than that", () => {
    expect(checkTimeout(5000, t + 15_000, t)).toBe(5000);
  });
  it("shortens the timeout to what is left of the run", () => {
    expect(checkTimeout(5000, t + 3_200, t)).toBe(3200);
    expect(checkTimeout(5000, t + 1_000, t)).toBe(1000);
  });
  it("skips the check when less than a second is left, or the deadline has passed", () => {
    expect(checkTimeout(5000, t + 999, t)).toBeNull();
    expect(checkTimeout(5000, t - 500, t)).toBeNull();
  });
});

describe("recheckable", () => {
  it("always checks on a scheduled run", () => {
    expect(recheckable(new Date(now.getTime() - 5_000), now, false)).toBe(true);
  });
  it("checks a monitor that was never checked", () => {
    expect(recheckable(null, now, true)).toBe(true);
  });
  it("skips, on a forced run, a monitor checked less than 50 s ago", () => {
    expect(recheckable(new Date(now.getTime() - 49_000), now, true)).toBe(false);
    expect(recheckable(new Date(now.getTime() - 50_000), now, true)).toBe(true);
  });
});

describe("taskFits", () => {
  it("defers status, logs, digest and eol when the run is short of time", () => {
    const deadline = 20_000;
    expect(taskFits("logs", deadline, 10_000)).toBe(true);
    expect(taskFits("logs", deadline, 11_500)).toBe(false);
    expect(taskFits("status", deadline, 14_500)).toBe(false);
    expect(taskFits("alerts", deadline, 19_000)).toBe(true);
    expect(taskFits("digest", deadline, 14_500)).toBe(false);
    expect(taskFits("eol", deadline, 14_500)).toBe(false);
    expect(taskFits("eol", deadline, 13_000)).toBe(true);
  });
  it("defers page views like logs when less than 9 s remain", () => {
    expect(taskFits("pageviews", 20_000, 11_000)).toBe(true);
    expect(taskFits("pageviews", 20_000, 11_500)).toBe(false);
  });
  it("keeps a few seconds of the 20 s run back for the alert rules", () => {
    expect(ALERTS_RESERVE_MS).toBeGreaterThanOrEqual(3_000);
    expect(ALERTS_RESERVE_MS).toBeLessThan(BUDGET_MS / 4);
  });
});

// Watchbell 1.2 (D11): a section the owner turned off pauses its collector tasks.
describe("paused sections", () => {
  // Review A1, Important 2: Auto-restore rides on the Supabase status task, so it keeps running in protect-only mode.
  it("keeps the protective Supabase status task due while Database is off, in protect-only mode", () => {
    const database = new Set(["database"] as const);
    expect(PROTECT_TASKS).toEqual(["supabase"]);
    expect(activeTasks(["supabase", "neon", "supabaseUsage"], database)).toEqual(["supabase"]);
    expect(protectOnly("supabase", database)).toBe(true);
    expect(protectOnly("supabase", new Set())).toBe(false);
    expect(protectOnly("checks", new Set(["hosting"] as const))).toBe(false);
  });

  it("gives every task a section (or none for the collector's own work)", () => {
    expect(Object.keys(TASK_SECTION).sort()).toEqual([...ORDER].sort());
    expect(TASK_SECTION).toMatchObject({ checks: "hosting", heartbeats: "hosting", vercel: "hosting", cloudflare: "hosting", supabase: "database", extraDbs: "database", alerts: null, digest: null, status: null });
  });

  // Watchbell 1.2.1: the security task reads for two sections (the Next.js check: Hosting; the GitHub dependency scan:
  // DevOps). It is paused only when both are off; with one off, the task skips that part (lib/data/security-task.ts).
  it("pauses the security task only when Hosting and DevOps are both off", () => {
    expect(TASK_ANY_SECTION).toEqual({ security: ["hosting", "devops"] });
    expect(activeTasks(["security"], new Set(["hosting"] as const))).toEqual(["security"]);
    expect(activeTasks(["security"], new Set(["devops"] as const))).toEqual(["security"]);
    expect(activeTasks(["security"], new Set(["hosting", "devops"] as const))).toEqual([]);
    expect(protectOnly("security", new Set(["hosting", "devops"] as const))).toBe(false);
  });

  it("leaves a paused section's tasks out of the run, and only theirs", () => {
    // A forced first run: the minute tasks and the first CATCH_UP_PER_RUN slower ones.
    expect(dueTasks({}, now, true)).toEqual(["heartbeats", "checks", "vercel", "supabase", "supabaseUsage", "alerts"]);
    expect(dueTasks({}, now, true, new Set(["hosting"] as const))).toEqual(["supabase", "supabaseUsage", "alerts"]);
    expect(dueTasks({}, now, true, new Set(["database"] as const))).not.toContain("supabaseUsage");
    expect(dueTasks({}, now, true, new Set(["database"] as const))).toContain("checks");
    expect(activeTasks(["checks", "neon", "alerts"], new Set(["hosting", "database"] as const))).toEqual(["alerts"]);
    expect(dueTasks({}, now, true, new Set())).toEqual(dueTasks({}, now, true));
  });

  it("doesn't spend a catch-up place on a paused task, and catches it up once its section is on again", () => {
    // Everything late (first run): only CATCH_UP_PER_RUN slower tasks start, and none of them is a paused one.
    const paused = new Set(["database"] as const);
    const first = slowOnly(dueTasks({}, now, false, paused));
    expect(first).toHaveLength(CATCH_UP_PER_RUN);
    expect(first.some((t) => TASK_SECTION[t as TaskName] === "database" && !PROTECT_TASKS.includes(t as TaskName))).toBe(false);
    // Turned on again: the database tasks never ran, so they are late and start catching up.
    const last = { ...fresh(now) };
    for (const t of ORDER) if (TASK_SECTION[t as TaskName] === "database") delete (last as Record<string, string>)[t];
    expect(slowOnly(dueTasks(last, now, false))).toEqual(["supabase", "supabaseUsage"]);
  });
});
