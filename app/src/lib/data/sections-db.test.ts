import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { accounts, alerts, monitors, resources, settings } from "@/db/schema";

// Watchbell 1.2 (D11): the section reads and the pause SQL run against a real database (PGlite, the self-host engine),
// not only as rendered text (review A1, minor 9).
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "http://127.0.0.1:3100", OPS_ENCRYPTION_KEY: "k" }) }));

import { listFiring, openAlertCount } from "./alerts-db";
import { deliverPending } from "./notify-db";
import { activeAlertFilter, monitorCounts, pausedSections, releaseHeldNotices, sectionState } from "./sections-db";
import { saveSectionsOff } from "./settings-db";

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 120_000);
afterAll(async () => {
  await client?.close();
});

const now = new Date("2026-10-21T10:00:00Z");
const account = async (provider: "vercel" | "supabase" | "drive" | "github") => {
  const [a] = await db.insert(accounts).values({ provider, label: provider, credentialCiphertext: "x", credentialIv: "y", credentialKind: "token" }).returning({ id: accounts.id });
  return a.id;
};
const alert = async (o: { ruleKey: string; subject: string; severity?: "critical" | "warning" | "info"; accountId?: string | null; pending?: "open" | null; pendingSince?: Date | null }) => {
  const [a] = await db.insert(alerts).values({
    ruleKey: o.ruleKey, subject: o.subject, severity: o.severity ?? "critical", title: o.subject, message: "m", startedAt: now, lastSeenAt: now,
    accountId: o.accountId ?? null, pending: o.pending ?? null, pendingSince: o.pendingSince ?? null,
  }).returning({ id: alerts.id });
  return a.id;
};

beforeEach(async () => {
  for (const t of [alerts, monitors, resources, accounts]) await db.delete(t);
  await db.delete(settings).where(eq(settings.key, "sections.off"));
});

describe("sectionState (one statement)", () => {
  it("shows Home, Hosting and Manage on an empty install", async () => {
    expect(await sectionState()).toEqual({ on: ["home", "hosting", "manage"], available: ["home", "hosting", "manage"], off: [], providers: [], has: { databases: false } });
  });

  it("reads the providers (not Google Drive), a database resource and the owner's switch", async () => {
    const supa = await account("supabase");
    await account("github");
    await account("drive");
    await db.insert(resources).values({ accountId: supa, kind: "supabase_project", externalId: "ref1", name: "db" });
    await saveSectionsOff(["devops"]);
    const s = await sectionState();
    expect(s.providers.sort()).toEqual(["github", "supabase"]);
    expect(s.has).toEqual({ databases: true });
    expect(s.available).toEqual(["home", "hosting", "database", "devops", "manage"]);
    expect(s.off).toEqual(["devops"]);
    expect(s.on).toEqual(["home", "hosting", "database", "manage"]);
    expect([...(await pausedSections())]).toEqual(["devops"]);
  });

  it("doesn't count a database that is gone", async () => {
    const vercel = await account("vercel");
    await db.insert(resources).values({ accountId: vercel, kind: "neon_project", externalId: "n", name: "n", goneAt: now });
    expect((await sectionState()).has.databases).toBe(false);
    expect((await sectionState()).on).toEqual(["home", "hosting", "manage"]);
  });
});

describe("the pause SQL against PGlite (review focus 5)", () => {
  it("leaves a paused section's alerts out of the bell and the Alerts page, and keeps them", async () => {
    const supa = await account("supabase");
    const vercel = await account("vercel");
    await alert({ ruleKey: "MonitorDown", subject: "m1" });
    await alert({ ruleKey: "DatabasePaused", subject: "d1", severity: "warning" });
    await alert({ ruleKey: "CredentialExpiring", subject: supa, severity: "warning", accountId: supa });
    await alert({ ruleKey: "CredentialExpiring", subject: vercel, severity: "warning", accountId: vercel });
    await alert({ ruleKey: "CollectorStale", subject: "collector" });
    expect(await openAlertCount()).toBe(5);

    await saveSectionsOff(["database"]);
    expect(await openAlertCount()).toBe(3);
    const shown = await listFiring(await pausedSections());
    expect(shown.map((a) => `${a.ruleKey}:${a.subject}`).sort()).toEqual(["CollectorStale:collector", "CredentialExpiring:" + vercel, "MonitorDown:m1"]);
    expect(await listFiring()).toHaveLength(5); // the rows are all still there

    await saveSectionsOff(["database", "hosting"]);
    expect(await openAlertCount()).toBe(1);
    const q = new PgDialect().sqlToQuery(activeAlertFilter(new Set(["hosting"]))!);
    expect(q.sql).toContain("not (");
  });

  it("doesn't read a paused section's pending notices, and releases them for the next run when it is on again", async () => {
    const old = new Date(Date.now() - 2 * 3_600_000); // waited 2 h: past the 30-minute drop rule
    const down = await alert({ ruleKey: "MonitorDown", subject: "m1", pending: "open", pendingSince: old });
    const paused = await alert({ ruleKey: "DatabasePaused", subject: "d1", pending: "open", pendingSince: new Date() });
    await saveSectionsOff(["hosting"]);
    const send = vi.fn().mockResolvedValue({ ok: true });
    expect(await deliverPending(now, Date.now() + 20_000, { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 1, dropped: 0 });
    const rows = await db.select({ id: alerts.id, pending: alerts.pending, claimedAt: alerts.claimedAt }).from(alerts);
    expect(rows.find((r) => r.id === paused)?.pending).toBeNull(); // Database is on: sent
    expect(rows.find((r) => r.id === down)).toEqual({ id: down, pending: "open", claimedAt: null }); // held, untouched

    // Hosting on again: the held notice gets a fresh window, so it is sent instead of dropped as stale.
    await saveSectionsOff([]);
    await releaseHeldNotices("hosting", new Date());
    send.mockClear();
    expect(await deliverPending(now, Date.now() + 20_000, { sender: { send, configured: new Set(["telegram"]) } })).toEqual({ sent: 1, dropped: 0 });
    expect(send.mock.calls[0][1]).toContain("MonitorDown");
  });
});

describe("monitorCounts", () => {
  it("counts the running uptime checks and heartbeats", async () => {
    const vercel = await account("vercel");
    const [app] = await db.insert(resources).values({ accountId: vercel, kind: "app", externalId: "p", name: "web" }).returning({ id: resources.id });
    await db.insert(monitors).values([
      { resourceId: app.id, kind: "http", url: "https://a.example/" },
      { resourceId: app.id, kind: "http", url: "https://b.example/" },
      { resourceId: app.id, kind: "http", url: "https://c.example/", paused: true },
      { resourceId: app.id, kind: "heartbeat", url: "", tokenHash: "h1", periodS: 3600, graceS: 600 },
    ]);
    expect(await monitorCounts()).toEqual({ http: 2, heartbeat: 1 });
  });
});
