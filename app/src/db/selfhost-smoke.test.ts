import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { tmpBase } from "../../test/tmp-base";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Self-host smoke (plan 2, task 8): the real boot path (ready() -> runMinute -> scheduler) on a throwaway PGlite folder.
// Nothing here may reach the production database: DATABASE_URL is forced empty (vitest never loads .env.local, and this
// test checks that), and every outbound fetch except localhost is refused.
const root = join(tmpBase, `selfhost-smoke-${process.pid}-${Date.now()}`);
const saved: Record<string, string | undefined> = {};
const KEYS = ["WATCHPOST_MODE", "WATCHPOST_DATA_DIR", "DATABASE_URL", "OPS_ENCRYPTION_KEY", "SITE_URL", "COLLECTOR_SECRET", "CRON_SECRET"] as const;
const realFetch = globalThis.fetch;
const blocked: string[] = [];
type Holder = { __watchpostPglite?: { db?: { $client?: { close(): Promise<void> } } } };

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  mkdirSync(root, { recursive: true });
  Object.assign(process.env, {
    WATCHPOST_MODE: "selfhost",
    WATCHPOST_DATA_DIR: root,
    DATABASE_URL: "",
    OPS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SITE_URL: "http://localhost:3100",
    COLLECTOR_SECRET: randomBytes(24).toString("hex"),
    CRON_SECRET: randomBytes(24).toString("hex"),
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    blocked.push(url);
    return Promise.reject(new Error(`smoke test: outbound fetch to ${new URL(url).hostname} blocked`));
  }) as typeof fetch;
  vi.resetModules();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  const g = globalThis as Holder;
  await g.__watchpostPglite?.db?.$client?.close().catch(() => undefined);
  delete g.__watchpostPglite;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
}, 120_000);

describe("self-host smoke (PGlite, no production database)", () => {
  it("boots, runs the collector once, has the seeded alert rules, and the scheduler wires up", async () => {
    expect(process.env.DATABASE_URL).toBe(""); // a test-set empty value, not something read from app/.env.local

    const { ready, db } = await import("./client");
    await ready();
    const { rowsOf } = await import("./rows");
    const { collectorRuns } = await import("./schema");

    // PGlite (not the production pooler) is behind db(): DATABASE_URL is empty and the handle is the PGlite client.
    expect((globalThis as Holder).__watchpostPglite?.db?.$client).toBeDefined();
    expect(rowsOf<{ v: string }>(await db().execute(sql`select version() as v`))[0].v).toMatch(/PostgreSQL/);

    const rules = rowsOf<{ n: number }>(await db().execute(sql`select count(*)::int as n from ops.alert_rules`))[0].n;
    expect(rules).toBeGreaterThan(0);

    const { runMinute } = await import("@/lib/collector/runners");
    const summary = await runMinute("builtin");
    expect(summary.skipped).toBe(false);

    const runs = await db().select().from(collectorRuns);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].trigger).toBe("manual"); // "builtin" is stored as manual
    expect(summary.ok, `collector errors: ${summary.errors.join(" | ")}`).toBe(true);
    // Every outbound attempt (the core's public-data steps) was refused, and the run still came out ok.
    expect(summary.ok).toBe(true);

    const { startScheduler } = await import("@/lib/scheduler/scheduler");
    const minute = vi.fn(async () => undefined);
    const daily = vi.fn(async () => undefined);
    const scheduler = startScheduler({
      tick: 50,
      now: () => new Date("2026-10-19T03:30:00+07:00"),
      minute,
      daily,
      readLastDay: async () => null,
      writeLastDay: async () => undefined,
    });
    try {
      await vi.waitFor(() => expect(minute).toHaveBeenCalled(), { timeout: 5000 });
    } finally {
      scheduler.stop();
    }
  }, 180_000); // a fresh PGlite, its migrations, cold imports of the collector and one run: 12 s alone, past 60 s in a
  // loaded full run (timed out 4 times, 25-26 Oct; the logs show the 60 s limit, never a failed assertion)

  // 1.1: the zone is a bound parameter of the uptime-days query, which Postgres only accepts because the query groups by
  // the column's position. Days follow the configured zone (Europe/Berlin here) in both the rollups and the raw checks.
  it("counts uptime days in the configured zone (WATCHBELL_TIMEZONE)", async () => {
    const { db } = await import("./client");
    const { accounts, checks, monitors, resources, rollupsHourly } = await import("./schema");
    const { monitorDays } = await import("@/lib/data/metrics-db");
    const { resetTimeZoneForTests } = await import("@/lib/time");
    const [account] = await db().insert(accounts).values({ provider: "vercel", label: "t", credentialCiphertext: "x", credentialIv: "x", credentialKind: "token" }).returning({ id: accounts.id });
    const [resource] = await db().insert(resources).values({ accountId: account.id, kind: "app", externalId: "prj_tz", name: "tz-app" }).returning({ id: resources.id });
    const [monitor] = await db().insert(monitors).values({ resourceId: resource.id, url: "https://tz.example.com/" }).returning({ id: monitors.id });
    // 21:00Z on 24 Oct is 23:00 CEST that day; 22:30Z is 00:30 CEST on the 25th (and 05:30 WIB on the 25th for both).
    await db().insert(rollupsHourly).values({ monitorId: monitor.id, hour: new Date("2026-10-24T21:00:00Z"), checks: 60, failures: 1 });
    await db().insert(checks).values({ monitorId: monitor.id, at: new Date("2026-10-24T22:30:00Z"), ok: false });
    const now = new Date("2026-10-26T12:00:00Z");
    try {
      resetTimeZoneForTests("Europe/Berlin");
      const berlin = (await monitorDays([monitor.id], now)).get(monitor.id);
      expect(berlin?.get("2026-10-24")).toMatchObject({ checks: 60, failures: 1 });
      expect(berlin?.get("2026-10-25")).toMatchObject({ checks: 1, failures: 1 });
      resetTimeZoneForTests();
      const wib = (await monitorDays([monitor.id], now)).get(monitor.id);
      expect(wib?.get("2026-10-25")).toMatchObject({ checks: 61, failures: 2 });

      // Final fix round: a name Postgres refuses never fails the page; the days use the configured zone's offset at
      // `now` (Berlin on 26 Oct is CET, +1 h, so 21:00Z and 22:30Z both fall on the 24th), with one warning.
      resetTimeZoneForTests("Europe/Berlin");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const soft = (await monitorDays([monitor.id], now, "Mars/Olympus")).get(monitor.id);
        expect(soft?.get("2026-10-24")).toMatchObject({ checks: 61, failures: 2 });
        expect(warn.mock.calls.filter(([m]) => String(m).includes("Mars/Olympus"))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    } finally {
      resetTimeZoneForTests();
    }
  }, 60_000);

  it("recognises Postgres's unknown-zone error, also inside drizzle's wrapper, and nothing else", async () => {
    const { db } = await import("./client");
    const { unknownZoneError } = await import("@/lib/data/metrics-db");
    const caught = await db().execute(sql`select now() at time zone ${"Mars/Olympus"} as t`).then(() => null, (e: unknown) => e);
    expect(caught).not.toBeNull();
    expect(unknownZoneError(caught)).toBe(true);
    const other = await db().execute(sql`select 1/0 as t`).then(() => null, (e: unknown) => e);
    expect(unknownZoneError(other)).toBe(false);
    expect(unknownZoneError(new Error("time zone \"X\" not recognized"))).toBe(false); // no SQLSTATE: not Postgres
    expect(unknownZoneError(null)).toBe(false);
  }, 60_000);
});
