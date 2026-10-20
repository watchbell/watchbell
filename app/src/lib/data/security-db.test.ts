import { beforeEach, describe, expect, it, vi } from "vitest";
import { appSecurity, events } from "@/db/schema";
import type { SecurityRow } from "@/lib/security/types";
import { fakeDb, limitOf, payloadOf } from "./fake-db";

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
    expect(r).toEqual({ checked: 2, skipped: 0, failed: [] });
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

  it("checks an app whose only monitor is a heartbeat on its vercel.app address, not an empty host (U3)", async () => {
    use([[{ id: "a1", name: "acme-shop", sec: null }], [{ resourceId: "a1", url: "heartbeat:backup-job" }]]);
    h.check.mockResolvedValue({ ...vuln, status: "ok", findings: [], version: "16.4.0" });
    await runSecurityChecks(Date.now() + 30_000);
    expect(h.check.mock.calls[0][0]).toBe("acme-shop.vercel.app");
  });

  it("skips what doesn't fit the deadline and writes nothing for it", async () => {
    const f = use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    expect(await runSecurityChecks(Date.now())).toEqual({ checked: 0, skipped: 1, failed: [] });
    expect(h.check).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("counts an app the check gave up on (null) as skipped", async () => {
    const f = use([[{ id: "a1", name: "nova-wallet", sec: null }], []]);
    h.check.mockResolvedValue(null);
    expect(await runSecurityChecks(Date.now() + 30_000)).toEqual({ checked: 0, skipped: 1, failed: [] });
    expect(f.writes).toEqual([]);
  });

  it("keeps going when one app fails", async () => {
    use([[{ id: "a1", name: "one", sec: null }, { id: "a2", name: "two", sec: null }], []]);
    h.check.mockImplementation(async (host: string) => { if (host === "one.vercel.app") throw new Error("boom"); return vuln; });
    const r = await runSecurityChecks(Date.now() + 30_000);
    expect(r.checked).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatch(/^one: /);
  });

  it("does nothing, with a single query, when no app is watched", async () => {
    const f = use([[]]);
    expect(await runSecurityChecks(Date.now() + 30_000)).toEqual({ checked: 0, skipped: 0, failed: [] });
    expect(f.queries).toHaveLength(1);
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
