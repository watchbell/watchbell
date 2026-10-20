import { describe, expect, it } from "vitest";
import { RETENTION_DAYS } from "@/lib/collector/retention";
import { BUDGET_DEFAULTS, BUDGET_FIELDS, budgetChanges, parseBudget, validateBudget } from "./budget";
import { parseRetention, RETENTION_CHOICES, RETENTION_KEYS, retentionChanges, validateRetention } from "./retention";

describe("retention settings (B6)", () => {
  it("every default is one of the choices, and every choice keeps a month for the backup where it matters", () => {
    for (const k of RETENTION_KEYS) expect(RETENTION_CHOICES[k]).toContain(RETENTION_DAYS[k]);
    for (const k of ["rollupsHourly", "events", "alerts"] as const) expect(Math.min(...RETENTION_CHOICES[k])).toBeGreaterThanOrEqual(35);
  });
  it("reads saved choices over the defaults and ignores anything else", () => {
    expect(parseRetention(null)).toEqual(RETENTION_DAYS);
    expect(parseRetention({ checks: 14, events: 1, storedLogs: "14", alerts: 180, junk: 5 })).toEqual({ ...RETENTION_DAYS, checks: 14, alerts: 180 });
  });
  it("validates a form (strings from selects) and names the bad fields", () => {
    const form = Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(RETENTION_DAYS[k])]));
    expect(validateRetention({ ...form, checks: "14" })).toEqual({ ok: true, value: { ...RETENTION_DAYS, checks: 14 } });
    const bad = validateRetention({ ...form, checks: "1", rollupsHourly: "9999" });
    expect(bad).toMatchObject({ ok: false, fieldErrors: { checks: "Pick 3, 7, 14 days.", rollupsHourly: "Pick 60, 90, 180 days." } });
  });
  it("describes what changed for the audit", () => {
    expect(retentionChanges(RETENTION_DAYS, { ...RETENTION_DAYS, checks: 14, events: 60 })).toBe("Raw checks 7 → 14 days, Events 90 → 60 days");
    expect(retentionChanges(RETENTION_DAYS, RETENTION_DAYS)).toBeNull();
  });
});

describe("budget limits (B6)", () => {
  it("defaults are the published free plans the page used before", () => {
    expect(BUDGET_DEFAULTS).toEqual({ qstashPerDay: 1000, webAnalyticsEvents: 50_000, vercelInvocations: 1_000_000, vercelCpuHours: 4, vercelMemoryGbH: 360, warnPct: 70, errPct: 90 });
    for (const f of BUDGET_FIELDS) expect(BUDGET_DEFAULTS[f.key]).toBeGreaterThanOrEqual(f.min);
  });
  it("reads saved limits within bounds and keeps warn below alarm", () => {
    expect(parseBudget({ qstashPerDay: 500, vercelCpuHours: -1, warnPct: 95, errPct: 90 })).toEqual({ ...BUDGET_DEFAULTS, qstashPerDay: 500 });
    expect(parseBudget("nonsense")).toEqual(BUDGET_DEFAULTS);
  });
  it("validates the form, accepting 1,000-style numbers", () => {
    const form = Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, String(BUDGET_DEFAULTS[f.key])]));
    expect(validateBudget({ ...form, vercelInvocations: "2,000,000" })).toEqual({ ok: true, value: { ...BUDGET_DEFAULTS, vercelInvocations: 2_000_000 } });
    expect(validateBudget({ ...form, warnPct: "90", errPct: "80" })).toMatchObject({ ok: false, fieldErrors: { errPct: "Alarm must be above Warn." } });
    expect(validateBudget({ ...form, qstashPerDay: "1.5" })).toMatchObject({ ok: false, fieldErrors: { qstashPerDay: expect.stringContaining("whole number") } });
  });
  it("describes what changed", () => {
    expect(budgetChanges(BUDGET_DEFAULTS, { ...BUDGET_DEFAULTS, qstashPerDay: 500 })).toBe("Upstash QStash messages 1,000 → 500");
  });
});
