import { describe, expect, it } from "vitest";
import { type AdvisorFacts, COMEBACK_MS, recommendations, visible } from "./rules";

const now = new Date("2026-10-13T00:00:00Z");
const DAY = 86_400_000;
const base: AdvisorFacts = { now, monitors: [], eol: null, headers: null, dbs: null, slots: null, links: null, accounts: [] };

describe("recommendations", () => {
  it("warns about a Next.js line reaching end of life within 30 days", () => {
    const r = recommendations({ ...base, eol: [{ appId: "a1", appName: "webs-ticketer", cycle: "15", eolFrom: new Date("2026-10-21T00:00:00Z"), latest: "16.4.0" }] });
    expect(r).toEqual([{ key: "next-eol:a1:15", severity: "warning", appId: "a1", subject: "webs-ticketer", title: "Next.js 15 reaches end of life on 21 Oct 2026",
      why: "No security fixes after that date. Latest is 16.4.0.", fix: "Upgrade to Next.js 16.", href: "https://endoflife.date/nextjs" }]);
  });
  it("words an end of life in the past in the past tense, and ignores one more than 30 days away", () => {
    const r = recommendations({ ...base, eol: [
      { appId: "a1", appName: "old", cycle: "14", eolFrom: new Date("2026-09-01T00:00:00Z"), latest: null },
      { appId: "a2", appName: "far", cycle: "15", eolFrom: new Date("2026-12-01T00:00:00Z"), latest: "16.4.0" },
      { appId: "a3", appName: "open", cycle: "16", eolFrom: null, latest: "16.4.0" },
    ] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: "next-eol:a1:14", title: "Next.js 14 reached end of life on 1 Sep 2026", why: "No security fixes after that date.", fix: "Upgrade Next.js." });
  });
  it("flags a root monitor answering 401/404", () => {
    const r = recommendations({ ...base, monitors: [{ id: "m1", appId: "a1", appName: "web-Quillpad", path: "/", kind: "http", name: null, lastStatus: 401, expectedStatus: 200, paused: false, lastPingAt: null, createdAt: now }] });
    expect(r[0]).toMatchObject({ key: "monitor-root:m1:401", severity: "info", title: "The monitor on / answers 401", href: "/uptime" });
  });
  it("leaves a healthy root monitor and a deeper path alone", () => {
    const m = { appId: "a1", appName: "x", kind: "http" as const, name: null, expectedStatus: 200, paused: false, lastPingAt: null, createdAt: now };
    expect(recommendations({ ...base, monitors: [{ ...m, id: "m1", path: "/", lastStatus: 200 }, { ...m, id: "m2", path: "/api/health", lastStatus: 404 }, { ...m, id: "m3", path: "/", lastStatus: null }, { ...m, id: "m4", path: "/", lastStatus: 401, expectedStatus: 401 }] })).toEqual([]);
  });
  it("lists missing security headers sorted, when stage 4 provides them", () => {
    const r = recommendations({ ...base, headers: [{ appId: "a1", appName: "x", missing: ["HSTS", "CSP"] }, { appId: "a2", appName: "y", missing: [] }] });
    expect(r.map((x) => [x.key, x.title])).toEqual([["headers:a1:CSP,HSTS", "Missing security headers: CSP, HSTS"]]);
  });
  it("flags full Supabase accounts, unlinked databases and broad tokens (stage 3 data)", () => {
    const dbs = [
      { id: "d1", name: "portfolio", provider: "supabase", accountId: "c1", accountLabel: "utama", state: "ok" },
      { id: "d2", name: "acme-shop", provider: "supabase", accountId: "c1", accountLabel: "utama", state: "ok" },
      { id: "d3", name: "ai-dev", provider: "supabase", accountId: "c2", accountLabel: "kedua", state: "ok" },
    ];
    const r = recommendations({ ...base, dbs, links: [{ appId: "a1", dbId: "d1" }, { appId: "a2", dbId: "d2" }],
      slots: [{ account: "utama", used: 2, total: 2, planUnknown: false }, { account: "kedua", used: 1, total: 2, planUnknown: false }],
      accounts: [{ id: "c1", provider: "supabase", label: "supabase 1", expiresAt: null, scopeNote: "all-access token" }] });
    expect(r.map((x) => x.key)).toEqual(["no-slot:utama", "db-unlinked:d3", "broad-cred:c1"]);
    expect(r[0]).toMatchObject({ severity: "warning", title: "Account utama has no free slot", why: "Both free projects are active, so a paused one can't be restored here." });
  });
  it("says so when the account's plan couldn't be read, and stays quiet while a slot is free", () => {
    const r = recommendations({ ...base, slots: [{ account: "utama", used: 2, total: 2, planUnknown: true }, { account: "kedua", used: 1, total: 2, planUnknown: true }] });
    expect(r.map((x) => x.key)).toEqual(["no-slot:utama"]);
    expect(r[0].why).toBe("Two projects are active. If this account is on the free plan (it couldn't be read), a paused one can't be restored here.");
  });
  it("skips the slot rule without slot data", () => {
    expect(recommendations({ ...base, slots: null })).toEqual([]);
  });
  it("ignores paused monitors", () => {
    const m = { appId: "a1", appName: "x", name: "job", expectedStatus: 200, paused: true, lastPingAt: null, createdAt: new Date(now.getTime() - 5 * DAY) };
    expect(recommendations({ ...base, monitors: [{ ...m, id: "h1", path: "heartbeat:job", kind: "heartbeat", lastStatus: null }, { ...m, id: "m1", path: "/", kind: "http", lastStatus: 404 }] })).toEqual([]);
  });
  it("leaves a heartbeat alone that has pinged or is less than a day old", () => {
    const h = { appId: "a1", appName: "x", path: "heartbeat:job", kind: "heartbeat" as const, name: "job", lastStatus: null, expectedStatus: 200, paused: false };
    const r = recommendations({ ...base, monitors: [
      { ...h, id: "h1", lastPingAt: new Date(now.getTime() - DAY), createdAt: new Date(now.getTime() - 9 * DAY) },
      { ...h, id: "h2", lastPingAt: null, createdAt: new Date(now.getTime() - DAY) },
      { ...h, id: "h3", lastPingAt: null, createdAt: new Date(now.getTime() - DAY + 1) },
    ] });
    expect(r).toEqual([]);
    expect(recommendations({ ...base, monitors: [{ ...h, id: "h4", lastPingAt: null, createdAt: new Date(now.getTime() - DAY - 1) }] }).map((x) => x.key)).toEqual(["hb-silent:h4"]);
  });
  it("mentions credentials expiring in 14–60 days (sooner is an alert) and silent heartbeats", () => {
    const r = recommendations({ ...base,
      accounts: [{ id: "c1", provider: "vercel", label: "acme", expiresAt: new Date(now.getTime() + 40 * DAY), scopeNote: null },
        { id: "c2", provider: "neon", label: "utama", expiresAt: new Date(now.getTime() + 5 * DAY), scopeNote: null }],
      monitors: [{ id: "h1", appId: "a1", appName: "acme-shop", path: "heartbeat:backup-job", kind: "heartbeat", name: "backup job", lastStatus: null, expectedStatus: 200, paused: false, lastPingAt: null, createdAt: new Date(now.getTime() - 2 * DAY) }] });
    expect(r.map((x) => x.key)).toEqual(["hb-silent:h1", "cred-60:c1:2026-11-22"]);
  });
  it("mentions a credential from 14 to 60 days out, inclusive, and not 13 days, 61 days or an expired one", () => {
    const at = (days: number, id: string) => ({ id, provider: "vercel", label: id, expiresAt: new Date(now.getTime() + days * DAY), scopeNote: null });
    const keys = (accounts: AdvisorFacts["accounts"]) => recommendations({ ...base, accounts }).map((x) => x.key);
    expect(keys([at(14, "a")])).toEqual(["cred-60:a:2026-10-27"]);
    expect(keys([at(60, "b")])).toEqual(["cred-60:b:2026-12-12"]);
    expect(keys([at(14, "a"), at(13.99, "c"), at(60.01, "d"), at(-3, "e")])).toEqual(["cred-60:a:2026-10-27"]);
  });
  it("keys a credential's expiry by its WIB day, like the title", () => {
    // 20:00 UTC on 22 Nov is 03:00 on 23 Nov in WIB.
    const r = recommendations({ ...base, accounts: [{ id: "c1", provider: "vercel", label: "acme", expiresAt: new Date("2026-11-22T20:00:00Z"), scopeNote: null }] });
    expect(r[0].key).toBe("cred-60:c1:2026-11-23");
    expect(r[0].title).toContain("23 Nov");
  });
  it("puts warnings first and keeps at most 50", () => {
    const monitors = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, appId: "a1", appName: "x", path: "/", kind: "http" as const, name: null, lastStatus: 404, expectedStatus: 200, paused: false, lastPingAt: null, createdAt: now }));
    const eol = [{ appId: "a1", appName: "x", cycle: "15", eolFrom: new Date("2026-10-21T00:00:00Z"), latest: null }];
    const r = recommendations({ ...base, monitors, eol });
    expect(r).toHaveLength(50);
    expect(r[0].severity).toBe("warning");
  });
});

describe("visible", () => {
  const rec = { key: "k", severity: "info" as const, appId: null, subject: "s", title: "t", why: "w", fix: "f", href: "/" };
  it("hides a dismissed item for 30 days, then shows it again", () => {
    expect(visible([rec], new Map([["k", new Date(now.getTime() - DAY)]]), now)).toEqual([]);
    expect(visible([rec], new Map([["k", new Date(now.getTime() - COMEBACK_MS)]]), now)).toEqual([rec]);
    expect(visible([rec], new Map(), now)).toEqual([rec]);
  });
});
