import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestSources } from "@/db/ingest-schema";
import { selfhostMigrationsFolder } from "@/db/pglite";
import * as schema from "@/db/schema";
import { alertRules, alerts } from "@/db/schema";
import { tokenHash } from "@/lib/heartbeat-token";
import type { ExternalAlertInput } from "@/lib/ingest/alertmanager";
import { INGEST_TOKEN } from "@/lib/ingest/token";

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({ db: () => h.db }));

import { applyExternalAlerts, countIngest, createSource, findSourceByHash, readSources, recentExternal, resolveStaleExternal, revokeSources } from "./ingest-db";

let client: PGlite;
const D = () => h.db as ReturnType<typeof drizzle>;
const now = new Date("2026-11-25T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const fire = (fp: string, o: Partial<ExternalAlertInput> = {}): ExternalAlertInput => ({
  subject: `am:${fp}`, status: "firing", severity: "critical", title: "HighErrorRate · pos-api", message: "5xx above 5%",
  labels: { alertname: "HighErrorRate", job: "pos-api" }, startedAt: ago(8), ...o,
});
const res = (fp: string) => fire(fp, { status: "resolved" });
const rows = (fp: string) => D().select().from(alerts).where(and(eq(alerts.ruleKey, "ExternalAlert"), eq(alerts.subject, `am:${fp}`)));

beforeAll(async () => {
  client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: selfhostMigrationsFolder() });
  h.db = db;
}, 60_000);
afterAll(async () => client?.close());

describe("ingest sources", () => {
  it("creates a source with a shown-once token, finds it by hash, and a second set-up disables the first", async () => {
    const a = await createSource("alertmanager");
    expect(a.token).toMatch(INGEST_TOKEN);
    expect(a.prefix).toBe(a.token.slice(0, 7));
    const found = await findSourceByHash(tokenHash(a.token));
    expect(found).toMatchObject({ id: a.id, kind: "alertmanager", name: "Alertmanager", enabled: true, tokenPrefix: a.prefix });
    expect(JSON.stringify(found)).not.toContain(a.token);
    const b = await createSource("alertmanager");
    expect(await findSourceByHash(tokenHash(a.token))).toBeNull();
    expect((await findSourceByHash(tokenHash(b.token)))?.id).toBe(b.id);
    expect((await readSources()).map((s) => [s.id, s.enabled])).toEqual([[b.id, true], [a.id, false]]);
  });

  // Final review M1: two set-ups at once (two tabs) can leave two enabled sources; Revoke must stop every one of them.
  it("revokes every enabled source of the kind", async () => {
    const s = await createSource("alertmanager");
    await D().insert(ingestSources).values({ kind: "alertmanager", tokenHash: tokenHash("am_second"), tokenPrefix: "am_seco" });
    expect(await revokeSources("alertmanager")).toBe(2);
    expect(await findSourceByHash(tokenHash(s.token))).toBeNull();
    expect(await findSourceByHash(tokenHash("am_second"))).toBeNull();
    expect(await revokeSources("alertmanager")).toBe(0);
  });

  it("counts this month, starts again in a new month, and sets last seen only when something was accepted", async () => {
    const s = await createSource("alertmanager");
    const src = (await findSourceByHash(tokenHash(s.token)))!;
    await countIngest(src, 3, 0, now);
    await countIngest(src, 2, 1, now);
    let [row] = await D().select().from(ingestSources).where(eq(ingestSources.id, s.id));
    expect(row).toMatchObject({ monthKey: "2026-11", receivedMonth: 5, refusedMonth: 1, lastSeenAt: now });
    const dec = new Date("2026-12-01T00:05:00Z");
    await countIngest(src, 0, 4, dec);
    [row] = await D().select().from(ingestSources).where(eq(ingestSources.id, s.id));
    expect(row).toMatchObject({ monthKey: "2026-12", receivedMonth: 0, refusedMonth: 4, lastSeenAt: now });
  });
});

describe("applyExternalAlerts", () => {
  let src: Awaited<ReturnType<typeof findSourceByHash>>;
  beforeAll(async () => { const s = await createSource("alertmanager"); src = await findSourceByHash(tokenHash(s.token)); });

  it("opens one alert per fingerprint with its labels, severity and start, and queues an open notice", async () => {
    expect(await applyExternalAlerts(src!, [fire("f1")], now)).toEqual({ opened: 1, touched: 0, resolved: 0 });
    const [a] = await rows("f1");
    expect(a).toMatchObject({ severity: "critical", title: "HighErrorRate · pos-api", message: "5xx above 5%", labels: { alertname: "HighErrorRate", job: "pos-api" }, startedAt: ago(8), pending: "open", resolvedAt: null });
  });

  it("the same firing again touches the open alert instead of opening a second one", async () => {
    await applyExternalAlerts(src!, [fire("f2")], now);
    expect(await applyExternalAlerts(src!, [fire("f2", { severity: "warning", message: "still 5xx" })], new Date(now.getTime() + 60_000))).toEqual({ opened: 0, touched: 1, resolved: 0 });
    const list = await rows("f2");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ message: "still 5xx", severity: "warning", lastSeenAt: new Date(now.getTime() + 60_000) });
  });

  it("resolved closes it, with a resolve notice only when the open was sent", async () => {
    await applyExternalAlerts(src!, [fire("f3"), fire("f4")], now);
    await D().update(alerts).set({ notifiedOpen: true, pending: null }).where(eq(alerts.subject, "am:f3"));
    expect(await applyExternalAlerts(src!, [res("f3"), res("f4")], now)).toEqual({ opened: 0, touched: 0, resolved: 2 });
    expect((await rows("f3"))[0]).toMatchObject({ resolvedAt: now, pending: "resolve" });
    expect((await rows("f4"))[0]).toMatchObject({ resolvedAt: now, pending: null });
  });

  it("a resolved for an alert Watchbell never opened changes nothing", async () => {
    expect(await applyExternalAlerts(src!, [res("never")], now)).toEqual({ opened: 0, touched: 0, resolved: 0 });
    expect(await rows("never")).toEqual([]);
  });

  it("the same fingerprint twice in one call: the last state wins", async () => {
    expect(await applyExternalAlerts(src!, [fire("f5"), res("f5")], now)).toEqual({ opened: 0, touched: 0, resolved: 0 });
    expect(await rows("f5")).toEqual([]);
    await applyExternalAlerts(src!, [fire("f6")], now);
    expect(await applyExternalAlerts(src!, [fire("f6"), res("f6")], now)).toEqual({ opened: 0, touched: 0, resolved: 1 });
    expect(await rows("f6")).toHaveLength(1);
  });

  it("no severity label takes the rule's severity", async () => {
    await applyExternalAlerts(src!, [fire("f7", { severity: null })], now);
    expect((await rows("f7"))[0].severity).toBe("warning");
  });

  it("opens nothing while the rule is off", async () => {
    await D().update(alertRules).set({ enabled: false }).where(eq(alertRules.key, "ExternalAlert"));
    expect(await applyExternalAlerts(src!, [fire("f8")], now)).toEqual({ opened: 0, touched: 0, resolved: 0 });
    expect(await rows("f8")).toEqual([]);
    await D().update(alertRules).set({ enabled: true }).where(eq(alertRules.key, "ExternalAlert"));
  });

  it("lists the latest external alerts, newest first", async () => {
    const list = await recentExternal(3);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ title: "HighErrorRate · pos-api" });
    expect(["firing", "resolved"]).toContain(list[0].status);
  });
});

describe("resolveStaleExternal", () => {
  it("closes alerts without word for 24 h and the Watchbell test alert after 5 minutes", async () => {
    const s = await createSource("alertmanager");
    const src = (await findSourceByHash(tokenHash(s.token)))!;
    await applyExternalAlerts(src, [fire("old"), fire("fresh"), fire("watchbell-test", { severity: "info" })], now);
    await D().update(alerts).set({ lastSeenAt: ago(25 * 60) }).where(eq(alerts.subject, "am:old"));
    await D().update(alerts).set({ lastSeenAt: ago(60) }).where(eq(alerts.subject, "am:fresh"));
    await D().update(alerts).set({ lastSeenAt: ago(6), notifiedOpen: true, pending: null }).where(eq(alerts.subject, "am:watchbell-test"));
    expect(await resolveStaleExternal(now)).toBe(2);
    expect((await rows("old"))[0].resolvedAt).toEqual(now);
    expect((await rows("fresh"))[0].resolvedAt).toBeNull();
    expect((await rows("watchbell-test"))[0]).toMatchObject({ resolvedAt: now, pending: "resolve" });
  });
});
