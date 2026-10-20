import { describe, expect, it } from "vitest";
import { badgeOf, isFresh, monitoredSummary, planSync, SYNC_PROVIDERS, syncKind, syncRowSub } from "./sync";

const now = new Date("2026-10-12T10:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("planSync", () => {
  const found = [
    { externalId: "p1", name: "one-renamed", meta: { teamId: "t" } },
    { externalId: "p3", name: "three", meta: { teamId: "t" } },
  ];
  const existing = [{ id: "r1", externalId: "p1", monitored: true, teamId: "t" }, { id: "r2", externalId: "p2", monitored: false, teamId: "t" }];

  it("updates known rows, inserts new ones unwatched, and marks missing ones gone", () => {
    expect(planSync(existing, found, { watchNew: false })).toEqual({
      update: [{ id: "r1", name: "one-renamed", meta: { teamId: "t" } }],
      insert: [{ externalId: "p3", name: "three", meta: { teamId: "t" }, monitored: false }],
      gone: ["r2"],
    });
  });

  it("treats a found app that matches an existing row as an update, even if that row was gone (the update clears goneAt)", () => {
    const plan = planSync([{ id: "r9", externalId: "p9", monitored: true, teamId: null }], [{ externalId: "p9", name: "nine", meta: {} }], { watchNew: false });
    expect(plan.update).toEqual([{ id: "r9", name: "nine", meta: {} }]);
    expect(plan.insert).toEqual([]);
    expect(plan.gone).toEqual([]);
  });

  it("keeps the apps of a team the token couldn't read: neither gone nor updated", () => {
    const rows = [...existing, { id: "r3", externalId: "p4", monitored: true, teamId: "skipped" }, { id: "r4", externalId: "p5", monitored: false, teamId: null }];
    const plan = planSync(rows, found, { watchNew: false, keepTeamIds: ["skipped"] });
    expect(plan.gone).toEqual(["r2", "r4"]);
    expect(plan.update.map((u) => u.id)).toEqual(["r1"]);
  });

  it("watches new ones when the account says so", () => {
    expect(planSync([], found, { watchNew: true }).insert.every((i) => i.monitored)).toBe(true);
  });
});

describe("isFresh", () => {
  it("is fresh for 24 hours while nobody has ticked it", () => {
    expect(isFresh({ firstSeenAt: hoursAgo(23), monitored: false }, now)).toBe(true);
    expect(isFresh({ firstSeenAt: hoursAgo(25), monitored: false }, now)).toBe(false);
    expect(isFresh({ firstSeenAt: hoursAgo(1), monitored: true }, now)).toBe(false);
  });
});

describe("monitoredSummary", () => {
  it("counts watched, total and new, ignoring gone rows", () => {
    expect(monitoredSummary([
      { monitored: true, firstSeenAt: hoursAgo(100), goneAt: null },
      { monitored: false, firstSeenAt: hoursAgo(2), goneAt: null },
      { monitored: false, firstSeenAt: hoursAgo(50), goneAt: null },
      { monitored: true, firstSeenAt: hoursAgo(3), goneAt: hoursAgo(1) },
    ], now)).toEqual({ on: 1, total: 3, fresh: 1 });
  });
});

describe("monitoredSummary by kind (I3)", () => {
  it("counts only the account's own kind, so another kind under it (a domain under Vercel) isn't a watched resource", () => {
    const r = (kind: string, monitored: boolean) => ({ kind, monitored, firstSeenAt: hoursAgo(100), goneAt: null });
    expect(monitoredSummary([r("app", true), r("app", false), r("domain", true), r("domain", true)], now, "app")).toEqual({ on: 1, total: 2, fresh: 0 });
  });
});

describe("syncKind", () => {
  it("is the one kind each provider's Sync stores, and null where Sync doesn't exist", () => {
    expect([syncKind("vercel"), syncKind("supabase"), syncKind("neon"), syncKind("firebase"), syncKind("cloudflare")])
      .toEqual(["app", "supabase_project", "neon_project", "firestore", "zone"]);
    expect([syncKind("drive"), syncKind("nope"), syncKind("constructor"), syncKind("toString")]).toEqual([null, null, null, null]);
  });
  it("offers Sync for every connectable provider", () => {
    expect(SYNC_PROVIDERS).toEqual(["vercel", "supabase", "neon", "firebase", "cloudflare", "turso", "upstash"]);
  });
});

describe("monitoredSummary keeps domain rows out of the Vercel count", () => {
  it("counts apps only, although stage 4 stores domains under the Vercel account", () => {
    const r = (kind: string, monitored: boolean) => ({ kind, monitored, firstSeenAt: hoursAgo(100), goneAt: null });
    expect(monitoredSummary([r("app", true), r("domain", true), r("domain", false)], now, syncKind("vercel"))).toEqual({ on: 1, total: 1, fresh: 0 });
    expect(monitoredSummary([r("zone", true), r("zone", false)], now, syncKind("cloudflare"))).toEqual({ on: 1, total: 2, fresh: 0 });
  });
});

describe("syncRowSub / badgeOf", () => {
  it("describes each kind in the Sync dialog", () => {
    expect(syncRowSub("app", { teamName: "Acme' projects" })).toBe("Vercel project · Acme' projects");
    expect(syncRowSub("supabase_project", { status: "INACTIVE", region: "ap-southeast-1" })).toBe("Supabase project · Paused · ap-southeast-1");
    expect(syncRowSub("neon_project", { region: "aws-ap-southeast-1" })).toBe("Neon project · aws-ap-southeast-1");
    expect(syncRowSub("firestore", {})).toBe("Firebase project");
    expect(syncRowSub("zone", { status: "active" })).toBe("Cloudflare zone · active");
    expect(syncRowSub("zone", {})).toBe("Cloudflare zone · unknown");
    expect([badgeOf("app"), badgeOf("neon_project"), badgeOf("firestore"), badgeOf("zone")]).toEqual(["app", "db", "fs", "dom"]);
  });
});
