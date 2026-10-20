import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendationDismissals, settings } from "@/db/schema";
import type { EolData } from "@/lib/security/eol";
import { fakeDb, limitOf, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { dismiss, listRecommendations, loadAdvisorFacts, runAdvisor, toEolFacts } from "./advisor-db";

const now = new Date("2026-10-13T00:00:00Z");
const use = (results: unknown[][], writes: unknown[][] = []) => {
  const f = fakeDb(results, writes);
  h.current = f;
  return f;
};
beforeEach(() => { h.current = null; });

const eolData: EolData = {
  checkedAt: "2026-10-12T20:00:00Z",
  cycles: [
    { name: "16", isEol: false, eolFrom: null, latest: "16.4.0" },
    { name: "15", isEol: false, eolFrom: "2026-10-21", latest: "15.5.9" },
    { name: "13", isEol: true, eolFrom: "2024-10-26", latest: "13.5.11" },
  ],
};

describe("toEolFacts", () => {
  it("maps each app's version to its cycle, with the newest supported release as latest", () => {
    const r = toEolFacts([
      { id: "a1", name: "tiket", version: "15.1.0" },
      { id: "a2", name: "hub", version: "16.4.0" },
      { id: "a3", name: "old", version: "13.0.0" },
      { id: "a4", name: "none", version: null },
      { id: "a5", name: "odd", version: "99.0.0" },
    ], eolData);
    expect(r).toEqual([
      { appId: "a1", appName: "tiket", cycle: "15", eolFrom: new Date("2026-10-21T00:00:00Z"), latest: "16.4.0" },
      { appId: "a2", appName: "hub", cycle: "16", eolFrom: null, latest: "16.4.0" },
      { appId: "a3", appName: "old", cycle: "13", eolFrom: new Date("2024-10-26T00:00:00Z"), latest: "16.4.0" },
    ]);
  });
  it("is null when endoflife.date hasn't been read yet", () => {
    expect(toEolFacts([{ id: "a1", name: "x", version: "15.1.0" }], null)).toBeNull();
  });
});

describe("loadAdvisorFacts", () => {
  it("reads watched monitors, versions, EOL, databases, links and accounts, each bounded", async () => {
    const f = use([
      [{ value: { cycles: eolData.cycles, checkedAt: eolData.checkedAt } }],
      // slot inputs: two active projects of one account, one of them unwatched (it borrows its org's plan); a paid org's pair doesn't count
      [{ r: { name: "portfolio", meta: {} }, s: { data: { status: "ACTIVE_HEALTHY", orgSlug: "o1", freeOrg: true } }, account: "utama" },
        { r: { name: "unwatched", meta: { status: "ACTIVE_HEALTHY", orgSlug: "o1" } }, s: null, account: "utama" },
        { r: { name: "p1", meta: {} }, s: { data: { status: "ACTIVE_HEALTHY", orgSlug: "o2", freeOrg: false } }, account: "paid" },
        { r: { name: "p2", meta: {} }, s: { data: { status: "ACTIVE_HEALTHY", orgSlug: "o2", freeOrg: false } }, account: "paid" }],
      [{ id: "m1", appId: "a1", appName: "tiket", url: "https://t.example.com/", kind: "http", name: null, lastStatus: 401, expectedStatus: 200, lastPingAt: null, createdAt: now, paused: false, ownerPaused: false },
        { id: "m2", appId: "a1", appName: "tiket", url: "heartbeat:backup-job", kind: "heartbeat", name: "backup job", lastStatus: null, expectedStatus: 200, lastPingAt: null, createdAt: now, paused: false, ownerPaused: true }],
      [{ id: "a1", name: "tiket", version: "15.1.0" }],
      [{ id: "d1", name: "portfolio", kind: "supabase_project", accountId: "c1", accountLabel: "utama", state: "ok" }, { id: "d2", name: "x", kind: "firestore", accountId: "c2", accountLabel: "fb", state: null }],
      [{ appId: "a1", dbId: "d1" }],
      [{ id: "c1", provider: "supabase", label: "utama", expiresAt: null, scopeNote: "all-access" }],
    ]);
    const facts = await loadAdvisorFacts(now);
    expect(facts.now).toBe(now);
    expect(facts.monitors.map((m) => [m.id, m.path, m.kind, m.paused])).toEqual([["m1", "/", "http", false], ["m2", "heartbeat:backup-job", "heartbeat", true]]);
    expect(facts.slots).toEqual([{ account: "paid", used: 0, total: 2, planUnknown: false }, { account: "utama", used: 2, total: 2, planUnknown: false }]);
    expect(facts.eol).toEqual([{ appId: "a1", appName: "tiket", cycle: "15", eolFrom: new Date("2026-10-21T00:00:00Z"), latest: "16.4.0" }]);
    expect(facts.headers).toBeNull();
    expect(facts.dbs).toEqual([
      { id: "d1", name: "portfolio", provider: "supabase", accountId: "c1", accountLabel: "utama", state: "ok" },
      { id: "d2", name: "x", provider: "firebase", accountId: "c2", accountLabel: "fb", state: "unknown" },
    ]);
    expect(facts.links).toEqual([{ appId: "a1", dbId: "d1" }]);
    expect(facts.accounts).toEqual([{ id: "c1", provider: "supabase", label: "utama", expiresAt: null, scopeNote: "all-access" }]);
    for (const i of [2, 3, 4, 5, 6]) expect(limitOf(f.queries[i])).toBe(200);
  });
});

const rec = { key: "k1", severity: "info", appId: "a1", subject: "tiket", title: "T", why: "w", fix: "f", href: "/uptime" };
const rec2 = { ...rec, key: "k2", appId: null, title: "U" };

describe("runAdvisor", () => {
  it("stores the computed items under advisor.latest", async () => {
    const f = use(
      [[], [], [], [], [], [], [{ id: "c1", provider: "vercel", label: "acme", expiresAt: new Date("2026-11-22T00:00:00Z"), scopeNote: null }]],
    );
    const items = await runAdvisor(now);
    expect(items.map((r) => r.key)).toEqual(["cred-60:c1:2026-11-22"]);
    const w = f.writes.find((x) => x.table === settings);
    expect(payloadOf(w!.calls)).toMatchObject({ key: "advisor.latest", value: { at: "2026-10-13T00:00:00.000Z", items } });
    expect(w!.calls.some((c) => c.method === "onConflictDoUpdate")).toBe(true);
  });
});

describe("listRecommendations", () => {
  it("shows the stored items minus the ones dismissed in the last 30 days", async () => {
    use([
      [{ value: { at: now.toISOString(), items: [rec, rec2] } }],
      [{ key: "k1", dismissedAt: new Date("2026-10-10T00:00:00Z") }],
    ]);
    expect((await listRecommendations(now)).map((r) => r.key)).toEqual(["k2"]);
  });
  it("brings an item back 30 days after it was dismissed", async () => {
    use([[{ value: { at: now.toISOString(), items: [rec] } }], [{ key: "k1", dismissedAt: new Date("2026-09-13T00:00:00Z") }]]);
    expect((await listRecommendations(now)).map((r) => r.key)).toEqual(["k1"]);
  });
  it("filters to one app", async () => {
    use([[{ value: { at: now.toISOString(), items: [rec, rec2] } }], []]);
    expect((await listRecommendations(now, "a1")).map((r) => r.key)).toEqual(["k1"]);
  });
  it("computes once when nothing is stored yet (first deploy)", async () => {
    const f = use([[], [], [], [], [], [], [], [], []]);
    expect(await listRecommendations(now)).toEqual([]);
    expect(f.writes.some((x) => x.table === settings)).toBe(true);
  });
  it("treats a malformed stored value as missing", async () => {
    const f = use([[{ value: { items: "nope" } }], [], [], [], [], [], [], [], []]);
    expect(await listRecommendations(now)).toEqual([]);
    expect(f.writes.some((x) => x.table === settings)).toBe(true);
  });
});

describe("dismiss", () => {
  it("records the dismissal of an item that is on the list", async () => {
    const f = use([[{ value: { at: now.toISOString(), items: [rec] } }]]);
    const r = await dismiss("k1", "user-1", now);
    expect(r).toEqual({ ok: true, title: "T", appId: "a1" });
    const w = f.writes.find((x) => x.table === recommendationDismissals);
    expect(payloadOf(w!.calls)).toEqual({ key: "k1", dismissedAt: now, dismissedBy: "user-1" });
    expect(w!.calls.find((c) => c.method === "onConflictDoUpdate")?.args[0]).toMatchObject({ set: { dismissedAt: now, dismissedBy: "user-1" } });
  });
  it("refuses a key that isn't on the list, or is too long, without touching the table", async () => {
    const f = use([[{ value: { at: now.toISOString(), items: [rec] } }]]);
    expect(await dismiss("zzz", "u", now)).toEqual({ ok: false, error: "That item is no longer on the list." });
    expect(await dismiss("x".repeat(201), "u", now)).toEqual({ ok: false, error: "Something in that request wasn't valid." });
    expect(f.writes).toEqual([]);
  });
});
