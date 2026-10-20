import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import { RETENTION_DAYS } from "@/lib/collector/retention";
import { TASKS } from "@/lib/collector/schedule";
import { BUDGET_DEFAULTS } from "@/lib/settings/budget";
import { budgetRows, durationText, everyText, retentionRows, retentionSchedule, runRows, taskScheduleRows, truncate, WATCHDOG_MESSAGES_PER_DAY, zoneSetting } from "./settings";

const apps = { total: 0, read: 0, enabled: 0 };

describe("everyText", () => {
  it("writes the intervals the collector uses", () => {
    expect([60, 300, 1800, 3600, 21_600, 86_400].map(everyText)).toEqual([
      "every 1 min", "every 5 min", "every 30 min", "every 1 h", "every 6 h", "every 1 day",
    ]);
  });
  it("falls back to seconds and plural days", () => {
    expect(everyText(45)).toBe("every 45 s");
    expect(everyText(172_800)).toBe("every 2 days");
  });
});

describe("taskScheduleRows", () => {
  it("has one row per task, in run order, each with a label", () => {
    const rows = taskScheduleRows();
    expect(rows.map((r) => r.task)).toEqual(Object.keys(TASKS));
    expect(rows.every((r) => r.label.length > 0)).toBe(true);
    expect(rows.find((r) => r.task === "pageviews")?.every).toBe("every 30 min");
  });
});

describe("runRows", () => {
  const base = { id: "1", startedAt: new Date("2026-10-12T20:30:00Z"), trigger: "cron_job_org", tasks: ["checks", "vercel"], ok: true, errorSummary: null, durationMs: 1900 };
  it("shows WIB time, trigger, task count, duration and OK", () => {
    expect(runRows([base])[0]).toMatchObject({ at: "13 Oct 03:30", trigger: "cron-job.org", tasks: "2 tasks", duration: "1.9 s", summary: "OK" });
  });
  it("truncates the error summary and marks unfinished runs", () => {
    const [bad, open] = runRows([{ ...base, ok: false, errorSummary: "x".repeat(200), tasks: ["a"] }, { ...base, ok: null, durationMs: null, tasks: [] }]);
    expect(bad.summary).toHaveLength(80);
    expect(bad.summary.endsWith("…")).toBe(true);
    expect(bad.tasks).toBe("1 task");
    expect(open).toMatchObject({ summary: "Not finished", duration: "—", tasks: "none" });
  });
  it("names a failed run without a summary", () => {
    expect(runRows([{ ...base, ok: false }])[0].summary).toBe("Finished with problems");
  });
  it("hides names before truncating, so a cut can't leave part of a real name (M8)", () => {
    const summary = `${"x".repeat(70)} keep-active/quillpad-production: Supabase returned an error (500).`;
    const hide = (t: string) => t.replace("quillpad-production", "db-a");
    const [row] = runRows([{ ...base, ok: false, errorSummary: summary }], hide);
    expect(row.summary).toHaveLength(80);
    expect(row.summary).not.toContain("skillp");
    const [whole] = runRows([{ ...base, ok: false, errorSummary: "keep-active/quillpad-production: boom" }], hide);
    expect(whole.summary).toBe("keep-active/db-a: boom");
  });
});

describe("truncate / durationText", () => {
  it("keeps short text and cuts long text", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(durationText(640)).toBe("640 ms");
  });
});

describe("budgetRows", () => {
  it("counts the watchdog at 288 messages a day", () => {
    expect(WATCHDOG_MESSAGES_PER_DAY).toBe(288);
    const q = budgetRows({ slots: [], neon: [], apps }).find((r) => r.key === "qstash")!;
    expect(q.use).toContain("288 / day");
    expect(q.pct).toBe(28.8);
  });
  it("gives one row per Supabase account and Neon project, with usage tones", () => {
    const rows = budgetRows({
      slots: [{ account: "main", used: 2, total: 2, planUnknown: false }, { account: "spare", used: 1, total: 2, planUnknown: true }],
      neon: [{ id: "n1", alias: "db-1", cu: { value: 75, pct: 75 } }, { id: "n2", alias: "db-2", cu: null }],
      apps,
    });
    expect(rows.find((r) => r.key === "supabase-main")).toMatchObject({ use: "2 of 2 used", pct: 100, tone: "err" });
    expect(rows.find((r) => r.key === "supabase-spare")?.use).toContain("plan not read");
    expect(rows.find((r) => r.key === "neon-n1")).toMatchObject({ use: "75 CU-hours", tone: "warn" });
    expect(rows.find((r) => r.key === "neon-n2")).toMatchObject({ use: "not read yet", pct: null, tone: "none" });
  });
  it("never invents numbers: Vercel and Web Analytics events read 'not read yet'", () => {
    const rows = budgetRows({ slots: [], neon: [], apps: { total: 3, read: 2, enabled: 1 } });
    expect(rows.find((r) => r.key === "vercel")?.use).toBe("not read yet");
    expect(rows.find((r) => r.key === "analytics")?.use).toBe("1 of 3 apps enabled · events not read yet");
    expect(budgetRows({ slots: [], neon: [], apps: { total: 2, read: 0, enabled: 0 } }).find((r) => r.key === "analytics")?.use).toContain("not read yet");
  });
  it("uses the Owner's saved limits and tones (stage 7, B6), the published ones by default", () => {
    const def = budgetRows({ slots: [], neon: [], apps });
    expect(def.find((r) => r.key === "vercel")?.limit).toBe("1M invocations, 4 h CPU, 360 GB-h memory / month");
    expect(def.find((r) => r.key === "analytics")?.limit).toBe("50,000 events / month");
    const rows = budgetRows({ slots: [], neon: [{ id: "n1", alias: "db-a", cu: { value: 60, pct: 60 } }], apps },
      { ...BUDGET_DEFAULTS, qstashPerDay: 500, vercelInvocations: 2_500_000, webAnalyticsEvents: 10_000, warnPct: 50, errPct: 95 });
    expect(rows.find((r) => r.key === "qstash")).toMatchObject({ limit: "500 / day", pct: 57.6, tone: "warn" });
    expect(rows.find((r) => r.key === "vercel")?.limit).toBe("2,500,000 invocations, 4 h CPU, 360 GB-h memory / month");
    expect(rows.find((r) => r.key === "analytics")?.limit).toBe("10,000 events / month");
    expect(rows.find((r) => r.key === "neon-n1")?.tone).toBe("warn");
  });
  it("has placeholder rows when nothing is connected", () => {
    const keys = budgetRows({ slots: [], neon: [], apps }).map((r) => r.key);
    expect(keys).toEqual(["supabase", "neon", "qstash", "cron", "vercel", "analytics"]);
  });
});

describe("retentionRows", () => {
  it("reads the days from the constants the daily job uses", () => {
    const rows = retentionRows();
    expect(rows).toHaveLength(Object.keys(RETENTION_DAYS).length);
    expect(rows.find((r) => r.kind === "Raw checks")?.keeps).toBe(`${RETENTION_DAYS.checks} days`);
    expect(rows.find((r) => r.kind === "Stored logs")?.keeps).toBe("7 days");
    expect(retentionRows({ ...RETENTION_DAYS, events: 30 }).find((r) => r.kind === "Events")?.keeps).toBe("30 days");
  });
});

describe("texts in the configured zone (1.1)", () => {
  afterEach(() => {
    resetTimeZoneForTests();
    vi.unstubAllEnvs();
  });

  it("say WIB by default", () => {
    resetTimeZoneForTests();
    expect(retentionSchedule()).toBe("Cleaned daily at 03:00 WIB");
    expect(zoneSetting(false)).toMatchObject({ zone: "Asia/Jakarta", label: "WIB", text: "Time zone: Asia/Jakarta (WIB). To change it, set WATCHBELL_TIMEZONE in .env." });
  });

  it("name another zone (self-host)", () => {
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    resetTimeZoneForTests("America/New_York");
    expect(retentionSchedule()).toBe("Cleaned daily at 03:00 America/New_York");
    expect(zoneSetting().zone).toBe("America/New_York");
    expect(["EST", "EDT"]).toContain(zoneSetting().label);
    expect(zoneSetting().text).toMatch(/^Time zone: America\/New_York \(E[SD]T\)\. To change it, set WATCHBELL_TIMEZONE in \.env\.$/);
  });
});

describe("the Settings time zone row (fix round 1)", () => {
  afterEach(() => {
    resetTimeZoneForTests();
    vi.restoreAllMocks();
  });

  it("in cloud says the daily job keeps Vercel Cron's time and where the variable is set", () => {
    resetTimeZoneForTests("Europe/Berlin");
    const z = zoneSetting(true);
    expect(z.text).toMatch(/^Time zone: Europe\/Berlin \(CES?T\)\. To change it, set WATCHBELL_TIMEZONE as a Vercel environment variable and redeploy\.$/);
    expect(z.follows).toMatch(/^Times and the digest \(07:00\) follow it\. The daily job is Vercel Cron at 20:00 UTC \(2[12]:00 CES?T\)\.$/);
    expect(zoneSetting(false).follows).toBe("Times, the daily job (03:00) and the digest (07:00) follow it.");
  });

  it("names a refused setting instead of showing the fallback silently", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetTimeZoneForTests("Asia/Jakata");
    expect(zoneSetting(false).text).toBe("WATCHBELL_TIMEZONE=Asia/Jakata isn't a time zone; using Asia/Jakarta (WIB). Set an IANA name such as Europe/Berlin in .env.");
  });
});
