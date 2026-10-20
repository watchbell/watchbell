import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshots } from "@/db/schema";
import { fakeDb, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, read: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/crypto", () => ({ openOrNull: () => "tok_abcdefghijklmnopqrstuvwxyz" }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "key" }) }));
vi.mock("@/lib/providers/vercel-analytics", () => ({ readPageViews: h.read }));

import { taskPageViews } from "./pageviews-db";

const NOW = new Date("2026-10-13T12:40:00Z");
const acc = { id: "acc1", credentialCiphertext: "c", credentialIv: "i" };
const target = (appId: string, name: string, projectId: string) => ({ appId, appName: name, projectId, deploymentId: `d-${appId}`, meta: { teamId: "team_a" } });
const T1 = target("a1", "acme-shop", "p1");
const T2 = target("a2", "portfolio", "p2");
const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  h.current = f;
  return f;
};
const on = { ok: true, enabled: true, total: 42, visitors: 17, hourly: [{ at: new Date("2026-10-13T11:00:00Z"), views: 30 }, { at: new Date("2026-10-13T12:00:00Z"), views: 12 }] };
const inserts = (f: ReturnType<typeof fakeDb>) => f.writes.filter((w) => w.table === snapshots && w.kind === "insert");
const dialect = new PgDialect();

beforeEach(() => {
  h.current = null;
  h.read.mockReset();
});

describe("taskPageViews", () => {
  it("reads each app's last 24 hours (23 whole hours plus this one) with its token, team and project", async () => {
    use([[acc], [T1, T2]]);
    h.read.mockResolvedValue(on);
    const errors: string[] = [];
    await taskPageViews(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual([]);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenCalledWith("tok_abcdefghijklmnopqrstuvwxyz", "team_a", "p1", { since: new Date("2026-10-12T13:00:00Z"), until: NOW });
    expect(h.read).toHaveBeenCalledWith("tok_abcdefghijklmnopqrstuvwxyz", "team_a", "p2", { since: new Date("2026-10-12T13:00:00Z"), until: NOW });
  });

  it("merges pageviews into the app's snapshot data (jsonb ||) and leaves state alone", async () => {
    const f = use([[acc], [T1]]);
    h.read.mockResolvedValue(on);
    await taskPageViews(NOW, Date.now() + 20_000, []);
    const ins = inserts(f);
    expect(ins).toHaveLength(1);
    const values = payloadOf(ins[0].calls) as { resourceId: string; data: { pageviews: unknown }; state?: string };
    expect(values.resourceId).toBe("a1");
    expect(values.state).toBeUndefined(); // the row's state is only ever set by the state refresh
    expect(values.data).toEqual({ pageviews: {
      enabled: true, total24h: 42, visitors24h: 17, readAt: NOW.toISOString(),
      hourly: [["2026-10-13T11:00:00.000Z", 30], ["2026-10-13T12:00:00.000Z", 12]],
    } });
    const conflict = ins[0].calls.find((c) => c.method === "onConflictDoUpdate")!.args[0] as { set: { data: never; state?: unknown } };
    expect(conflict.set.state).toBeUndefined();
    const q = dialect.sqlToQuery(conflict.set.data);
    expect(q.sql).toContain("||");
    expect(q.sql).toContain("::jsonb");
    expect(JSON.parse(q.params[0] as string).pageviews.total24h).toBe(42);
  });

  it("stores enabled: false for a project without Web Analytics", async () => {
    const f = use([[acc], [T1]]);
    h.read.mockResolvedValue({ ok: true, enabled: false });
    await taskPageViews(NOW, Date.now() + 20_000, []);
    expect((payloadOf(inserts(f)[0].calls) as { data: unknown }).data).toEqual({ pageviews: { enabled: false, readAt: NOW.toISOString() } });
  });

  it("stores 0 views as 0", async () => {
    const f = use([[acc], [T1]]);
    h.read.mockResolvedValue({ ok: true, enabled: true, total: 0, visitors: 0, hourly: [] });
    await taskPageViews(NOW, Date.now() + 20_000, []);
    expect((payloadOf(inserts(f)[0].calls) as { data: { pageviews: { total24h: number } } }).data.pageviews).toMatchObject({ enabled: true, total24h: 0, visitors24h: 0, hourly: [] });
  });

  it("on a failed read writes nothing for that app (the last good value stays) and adds one error line; the others still go", async () => {
    const f = use([[acc], [T1, T2]]);
    h.read.mockImplementation(async (_t: string, _team: string, project: string) => (project === "p1" ? { ok: false, kind: "transient", error: "Vercel says there were too many requests." } : on));
    const errors: string[] = [];
    await taskPageViews(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual(["pageviews/acme-shop: Vercel says there were too many requests."]);
    const ins = inserts(f);
    expect(ins).toHaveLength(1);
    expect((payloadOf(ins[0].calls) as { resourceId: string }).resourceId).toBe("a2");
  });

  it("an auth failure is one error line, nothing written", async () => {
    const f = use([[acc], [T1]]);
    h.read.mockResolvedValue({ ok: false, kind: "auth", error: "Vercel rejected this credential (403).", status: 403 });
    const errors: string[] = [];
    await taskPageViews(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual(["pageviews/acme-shop: Vercel rejected this credential (403)."]);
    expect(inserts(f)).toHaveLength(0);
  });

  it("a failed save is reported without the database's text and doesn't stop the other apps", async () => {
    const f = fakeDb([[acc], [T1, T2]], [new Error("connection refused postgres://u:pw@host"), []]);
    h.current = f;
    h.read.mockResolvedValue(on);
    const errors: string[] = [];
    await taskPageViews(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual(["pageviews/acme-shop: couldn't save the page views"]);
    expect(inserts(f)).toHaveLength(2);
  });

  it("skips apps (quietly, no read) when less than a read's time is left before the deadline", async () => {
    const f = use([[acc], [T1, T2]]);
    const errors: string[] = [];
    await taskPageViews(NOW, Date.now() + 5_000, errors);
    expect(h.read).not.toHaveBeenCalled();
    expect(inserts(f)).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it("does nothing without a Vercel account or watched apps", async () => {
    use([[]]);
    await taskPageViews(NOW, Date.now() + 20_000, []);
    use([[acc], []]);
    await taskPageViews(NOW, Date.now() + 20_000, []);
    expect(h.read).not.toHaveBeenCalled();
  });
});
