import { beforeEach, describe, expect, it, vi } from "vitest";
import { appSecurity, events } from "@/db/schema";
import type { SecurityRow } from "@/lib/security/types";
import { PgDialect } from "drizzle-orm/pg-core";
import { fakeDb, limitOf, payloadOf, whereOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, check: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/security/check", () => ({ checkNextSecurity: h.check }));

import { checkSecurityNow, runSecurityChecks } from "./security-db";

const AT = new Date("2026-10-12T20:00:00Z");
const vuln: SecurityRow = {
  version: "15.1.0", status: "vulnerable", reason: null, checkedAt: AT,
  findings: [{ id: "GHSA-f82v-jwr5-mffw", cve: "CVE-2025-29927", summary: "Authorization Bypass in Next.js Middleware", severity: "CRITICAL", fixed: "15.2.3" }],
};
const prevRow = { resourceId: "a1", framework: "next", version: "15.1.0", status: "ok", findings: [], reason: null, checkedAt: new Date("2026-10-11T20:00:00Z") };

const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  h.current = f;
  return f;
};

beforeEach(() => {
  h.current = null;
  h.check.mockReset();
});

describe("runSecurityChecks", () => {
  it("checks each watched app on its monitor's host, stores the row and a change event", async () => {
    const f = use([
      [{ id: "a1", name: "nova-wallet", sec: prevRow }, { id: "a2", name: "acme-shop", sec: null }],
      [{ resourceId: "a1", url: "https://nova.example.com/api/health" }],
    ]);
    h.check.mockImplementation(async (host: string) => (host === "nova.example.com" ? vuln : { ...vuln, status: "ok", findings: [], version: "16.4.0" }));
    const r = await runSecurityChecks(Date.now() + 30_000);
    expect({ ...r, done: [...r.done].sort(), started: [...r.started].sort() }).toEqual({ checked: 2, skipped: 0, failed: [], done: ["a1", "a2"], listed: ["a1", "a2"], started: ["a1", "a2"] });
    expect(limitOf(f.queries[0])).toBe(200);
    expect(h.check.mock.calls.map((c) => [c[0], c[1]?.status ?? null])).toEqual([["nova.example.com", "ok"], ["acme-shop.vercel.app", null]]);

    const upserts = f.writes.filter((w) => w.table === appSecurity);
    expect(upserts.map((w) => payloadOf(w.calls)?.resourceId)).toEqual(["a1", "a2"]);
    expect(payloadOf(upserts[0].calls)).toMatchObject({ status: "vulnerable", version: "15.1.0", findings: vuln.findings, checkedAt: AT });
    expect(upserts[0].calls.some((c) => c.method === "onConflictDoUpdate")).toBe(true);

    // Only nova-wallet changed (ok → vulnerable); acme-shop's first clean check says nothing.
    // R2: a bump attempt (nothing to bump), then the insert with the reason.
    const evs = f.writes.filter((w) => w.table === events);
    expect(evs.map((w) => w.kind)).toEqual(["update", "insert"]);
    expect(payloadOf(evs[1].calls)).toMatchObject({
      type: "system", kind: "err", resourceId: "a1", message: "nova-wallet runs Next.js 15.1.0 with 1 known vulnerability (critical)", detail: "GHSA-f82v-jwr5-mffw",
      reason: "NextVulnerable",
    });
  });

  // Watchbell 1.2.1: the stored primary domain (the one production is served on) beats a monitor still on an old domain.
  it("checks an app on its stored primary domain when it has one, else its monitor's host", async () => {
    use([
      [{ id: "a1", name: "shopfront", meta: { primaryDomain: "finance.example.com" }, sec: null }, { id: "a2", name: "acme-shop", meta: { teamId: "t" }, sec: null }],
      [{ resourceId: "a1", url: "https://old-finance.example.net/" }, { resourceId: "a2", url: "https://shop.example.com/" }],
    ]);
    h.check.mockResolvedValue({ ...vuln, status: "ok", findings: [], version: "16.4.0" });
    await runSecurityChecks(Date.now() + 30_000);
    expect(h.check.mock.calls.map((c) => c[0]).sort()).toEqual(["finance.example.com", "shop.example.com"]);
  });

  it("checks an app whose only monitor is a heartbeat on its vercel.app address, not an empty host (U3)", async () => {
    use([[{ id: "a1", name: "acme-shop", sec: null }], [{ resourceId: "a1", url: "heartbeat:backup-job" }]]);
    h.check.mockResolvedValue({ ...vuln, status: "ok", findings: [], version: "16.4.0" });
    await runSecurityChecks(Date.now() + 30_000);
    expect(h.check.mock.calls[0][0]).toBe("acme-shop.vercel.app");
  });

  it("skips what doesn't fit the deadline and writes nothing for it", async () => {
    const f = use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    expect(await runSecurityChecks(Date.now())).toEqual({ checked: 0, skipped: 1, failed: [], done: [], listed: ["a1"], started: [] });
    expect(h.check).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("counts an app the check gave up on (null) as skipped", async () => {
    const f = use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    h.check.mockResolvedValue(null);
    // It started and ran out of time: an attempt (fix round 1), not done.
    expect(await runSecurityChecks(Date.now() + 30_000)).toEqual({ checked: 0, skipped: 1, failed: [], done: [], listed: ["a1"], started: ["a1"] });
    expect(f.writes).toEqual([]);
  });

  it("keeps going when one app fails", async () => {
    use([[{ id: "a1", name: "one", sec: null }, { id: "a2", name: "two", sec: null }], []]);
    h.check.mockImplementation(async (host: string) => { if (host === "one.vercel.app") throw new Error("boom"); return vuln; });
    const r = await runSecurityChecks(Date.now() + 30_000);
    expect(r.checked).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatch(/^one: /);
    expect(r.done.sort()).toEqual(["a1", "a2"]); // a failed check was tried: done for the after-deploy mark
  });

  it("does nothing, with a single query, when no app is watched", async () => {
    const f = use([[]]);
    expect(await runSecurityChecks(Date.now() + 30_000)).toEqual({ checked: 0, skipped: 0, failed: [], done: [], listed: [], started: [] });
    expect(f.queries).toHaveLength(1);
  });

  // Watchbell 1.2.1: the apps marked after a new production deployment are checked first; an early run checks only them.
  const A1 = "11111111-1111-4111-8111-111111111111";
  const A2 = "22222222-2222-4222-8222-222222222222";
  it("checks the marked apps first, whatever their last check", async () => {
    use([[{ id: A1, name: "old", sec: null }, { id: A2, name: "fresh", sec: prevRow }], []]);
    h.check.mockResolvedValue(vuln);
    const order: string[] = [];
    h.check.mockImplementation(async (host: string) => { order.push(host); return vuln; });
    const r = await runSecurityChecks(Date.now() + 30_000, { first: [A2] });
    expect(order[0]).toBe("fresh.vercel.app");
    expect(r.listed).toEqual([A2, A1]);
  });

  it("with `only`, reads and checks just those apps", async () => {
    const f = use([[{ id: A2, name: "fresh", sec: prevRow }], []]);
    h.check.mockResolvedValue(vuln);
    const r = await runSecurityChecks(Date.now() + 30_000, { only: [A2] });
    expect(r).toMatchObject({ checked: 1, done: [A2], listed: [A2] });
    expect(new PgDialect().sqlToQuery(whereOf(f.queries[0])!.getSQL() as never).params).toContain(A2);
    // Nothing to check: no query at all.
    const g = use([]);
    expect(await runSecurityChecks(Date.now() + 30_000, { only: [] })).toEqual({ checked: 0, skipped: 0, failed: [], done: [], listed: [], started: [] });
    expect(g.queries).toHaveLength(0);
  });

  // Fix round 1: a slot that continues over several minute runs leaves out the apps it already tried.
  it("with `skip`, leaves those apps out of the read", async () => {
    const f = use([[{ id: A1, name: "old", sec: null }], []]);
    h.check.mockResolvedValue(vuln);
    expect(await runSecurityChecks(Date.now() + 30_000, { skip: [A2] })).toMatchObject({ listed: [A1] });
    expect(new PgDialect().sqlToQuery(whereOf(f.queries[0])!.getSQL() as never).sql).toMatch(/not in/);
  });
});

describe("checkSecurityNow", () => {
  it("checks one app, stores it, and returns the toast text and the audit entry", async () => {
    const f = use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    h.check.mockResolvedValue(vuln);
    expect(await checkSecurityNow("a1")).toEqual({
      ok: true, message: "nova-wallet runs Next.js 15.1.0 with 1 known vulnerability.", passed: true, vulnerable: true,
      audit: { message: "Security check: nova-wallet", resourceId: "a1" },
    });
    expect(f.writes.filter((w) => w.table === appSecurity)).toHaveLength(1);
  });

  it("reports a failed check as not passed", async () => {
    use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    h.check.mockResolvedValue({ ...vuln, status: "error", findings: [], version: null, reason: "Couldn't load the site: HTTP 502" });
    expect(await checkSecurityNow("a1")).toMatchObject({ ok: true, passed: false, vulnerable: false, message: "The check failed: Couldn't load the site: HTTP 502." });
  });

  it("says so when the app isn't watched any more", async () => {
    const f = use([[]]);
    expect(await checkSecurityNow("a1")).toEqual({ ok: false, error: "That app is no longer in the console." });
    expect(h.check).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("says so when the check ran out of time", async () => {
    use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    h.check.mockResolvedValue(null);
    expect(await checkSecurityNow("a1")).toEqual({ ok: false, error: "The check took too long. Try again in a minute." });
  });
});

describe("saving a result: serialised per app, against the stored row", () => {
  const stored = (over: Record<string, unknown>) => ({ ...prevRow, ...over });
  const target = [{ id: "a1", name: "nova-wallet", sec: null }];

  it("locks the app's row for the write and only overwrites an older result", async () => {
    const f = use([target, [], [stored({})]]);
    h.check.mockResolvedValue(vuln);
    await checkSecurityNow("a1");
    expect(f.executes()).toBe(1);
    const up = f.writes.find((w) => w.table === appSecurity)!;
    const conflict = up.calls.find((c) => c.method === "onConflictDoUpdate")?.args[0] as { setWhere?: unknown };
    expect(conflict.setWhere).toBeDefined();
  });

  it("writes no event when a run that finished first already stored the same findings", async () => {
    // Read before the check: never checked. Stored by the time this one saves: the same vulnerable result, older.
    const f = use([target, [], [stored({ status: "vulnerable", findings: vuln.findings, checkedAt: new Date(AT.getTime() - 1000) })]]);
    h.check.mockResolvedValue(vuln);
    await checkSecurityNow("a1");
    expect(f.writes.filter((w) => w.table === events)).toEqual([]);
    expect(f.writes.filter((w) => w.table === appSecurity)).toHaveLength(1);
  });

  it("writes nothing when a newer result is already stored", async () => {
    const f = use([target, [], [stored({ checkedAt: new Date(AT.getTime() + 1000) })]]);
    h.check.mockResolvedValue(vuln);
    expect(await checkSecurityNow("a1")).toMatchObject({ ok: true });
    expect(f.writes).toEqual([]);
  });

  it("rebases an unknown or failed result on the stored version and findings", async () => {
    const f = use([target, [], [stored({ status: "vulnerable", findings: vuln.findings })]]);
    h.check.mockResolvedValue({ version: null, status: "unknown", findings: [], reason: "version not exposed", checkedAt: AT });
    await checkSecurityNow("a1");
    expect(payloadOf(f.writes.find((w) => w.table === appSecurity)!.calls)).toMatchObject({
      status: "unknown", version: "15.1.0", findings: vuln.findings, reason: "version not exposed", checkedAt: AT,
    });
    expect(f.writes.filter((w) => w.table === events)).toEqual([]);
  });
});
