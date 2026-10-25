import { describe, expect, it } from "vitest";
import { appDomainsMeta, domainMove, hostAttached, monitorMoves, movedUrl, stickyPastDomains, storedDomains } from "./domain-move";

const d = (name: string, o: Partial<{ redirect: string; verified: boolean; gitBranch: string; customEnvironmentId: string }> = {}) =>
  ({ name, redirect: o.redirect ?? null, verified: o.verified ?? true, gitBranch: o.gitBranch ?? null, customEnvironmentId: o.customEnvironmentId ?? null });

const moved = { name: "shopfront", meta: { teamId: "t", domains: ["finance.example.com", "demo-finance.example.com", "shopfront.vercel.app"], primaryDomain: "finance.example.com" } };

describe("appDomainsMeta", () => {
  it("stores every listed name and the domain production is served on", () => {
    expect(appDomainsMeta([
      d("demo-finance.example.com"), d("old-finance.example.net", { redirect: "finance.example.com" }),
      d("Finance.example.com"), d("new.example.com", { verified: false }),
    ], "shopfront")).toEqual({
      domains: ["demo-finance.example.com", "old-finance.example.net", "finance.example.com", "new.example.com"],
      primaryDomain: "finance.example.com", pastDomains: [],
    });
  });
  it("falls back to <name>.vercel.app with no domains", () => {
    expect(appDomainsMeta([], "web")).toEqual({ domains: [], primaryDomain: "web.vercel.app", pastDomains: [] });
  });
});

describe("domainMove: only with evidence of a move (coordinator ruling)", () => {
  const app = { name: "shopfront", meta: { domains: ["finance.example.com"], primaryDomain: "finance.example.com", pastDomains: ["old-finance.example.net"] } };
  it("a non-Vercel host the project never listed is never moved, even when failing", () => {
    expect(domainMove("https://api.mybackend.com/health", app, [], { lastError: "HTTP 502" })).toBeNull();
    expect(domainMove("https://api.mybackend.com/health", app)).toBeNull();
  });
  it("Vercel's DEPLOYMENT_NOT_FOUND on an unlisted host is a move", () => {
    expect(domainMove("https://gone.example.com/", app, [], { lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" })).toEqual({ from: "gone.example.com", to: "finance.example.com" });
  });
  it("a host the project listed before is a move, whatever the check says", () => {
    expect(domainMove("https://old-finance.example.net/x", app, [], { lastError: null })).toEqual({ from: "old-finance.example.net", to: "finance.example.com" });
  });
  it("an attached host is never a move, even with DEPLOYMENT_NOT_FOUND", () => {
    expect(domainMove("https://finance.example.com/", app, [], { lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" })).toBeNull();
  });
});

describe("appDomainsMeta: pastDomains", () => {
  it("remembers names that disappear from the project, drops ones that come back, keeps at most 20", () => {
    const old = { domains: ["old.example.com", "keep.example.com"], primaryDomain: "old.example.com", pastDomains: ["older.example.com", "keep.example.com"] };
    expect(appDomainsMeta([d("keep.example.com"), d("new.example.com")], "web", [], old).pastDomains).toEqual(["older.example.com", "old.example.com"]);
    const many = { domains: [], primaryDomain: "x", pastDomains: Array.from({ length: 25 }, (_, i) => `p${i}.example.com`) };
    expect(appDomainsMeta([], "web", [], many).pastDomains).toHaveLength(20);
    expect(appDomainsMeta([d("a.example.com")], "web").pastDomains).toEqual([]);
  });
});

describe("hostAttached / domainMove", () => {
  it("an attached host changes nothing: primary, a listed one, a pending one, the vercel.app names", () => {
    for (const host of ["finance.example.com", "demo-finance.example.com", "shopfront.vercel.app", "shopfront-acme.vercel.app", "FINANCE.example.com"]) {
      expect(hostAttached(host, moved)).toBe(true);
    }
    expect(domainMove("https://shopfront-git-main-acme.vercel.app/", moved)).toBeNull();
  });
  it("a monitor on the old domain is a move to the primary domain", () => {
    expect(domainMove("https://old-finance.example.net/health?x=1", moved, [], { lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" })).toEqual({ from: "old-finance.example.net", to: "finance.example.com" });
  });
  it("a domain another watched project lists is not a move (shared domain)", () => {
    const other = { name: "blog", meta: { domains: ["old-finance.example.net"], primaryDomain: "old-finance.example.net" } };
    expect(domainMove("https://old-finance.example.net/blog", moved, [other], { lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" })).toBeNull();
  });
  it("an app without stored domains keeps the existing behaviour", () => {
    expect(storedDomains({ teamId: "t" })).toBeNull();
    expect(domainMove("https://anything.example.com/", { name: "web", meta: { teamId: "t" } }, [], { lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" })).toBeNull();
    expect(domainMove("not a url", moved)).toBeNull();
  });
});

describe("movedUrl", () => {
  it("rewrites the host and keeps the path and query", () => {
    expect(movedUrl("https://old-finance.example.net/api/health?deep=1", "finance.example.com")).toBe("https://finance.example.com/api/health?deep=1");
    expect(movedUrl("https://old.example.com:8443/", "new.example.com")).toBe("https://new.example.com/");
  });
});

describe("monitorMoves", () => {
  it("lists the HTTP monitors on a detached host only", () => {
    const m = (id: string, url: string, kind = "http") => ({ id, kind, url, appId: "a1", appName: moved.name, appMeta: moved.meta, lastError: "HTTP 404 · DEPLOYMENT_NOT_FOUND" });
    const r = monitorMoves([m("old", "https://old-finance.example.net/"), m("new", "https://finance.example.com/"), m("hb", "heartbeat:x", "heartbeat")], [{ id: "a1", ...moved }]);
    expect([...r]).toEqual([["old", { from: "old-finance.example.net", to: "finance.example.com" }]]);
  });
});

// Review T3 I2: Vercel's DEPLOYMENT_NOT_FOUND is remembered as a past domain, so a timeout or a 5xx in between doesn't
// flip the monitor back to MonitorDown (and a rollback proposal) and then forth again.
describe("stickyPastDomains", () => {
  const app = { id: "a1", name: "shopfront", meta: { domains: ["finance.example.com"], primaryDomain: "finance.example.com", pastDomains: ["x.example.com"] } };
  const mon = (lastError: string | null, url = "https://old-finance.example.net/") => ({ id: "m1", kind: "http", url, appId: "a1", appName: app.name, appMeta: app.meta, lastError });
  it("records a host seen as moved through DEPLOYMENT_NOT_FOUND, once", () => {
    expect([...stickyPastDomains([mon("HTTP 404 · DEPLOYMENT_NOT_FOUND")], [app])]).toEqual([["a1", ["x.example.com", "old-finance.example.net"]]]);
    const known = { ...app, meta: { ...app.meta, pastDomains: ["old-finance.example.net"] } };
    expect(stickyPastDomains([{ ...mon("HTTP 404 · DEPLOYMENT_NOT_FOUND"), appMeta: known.meta }], [known]).size).toBe(0);
  });
  it("records nothing for an attached host, a non-Vercel failure or an app without stored domains", () => {
    expect(stickyPastDomains([mon("HTTP 404 · DEPLOYMENT_NOT_FOUND", "https://finance.example.com/")], [app]).size).toBe(0);
    expect(stickyPastDomains([mon("HTTP 502")], [app]).size).toBe(0);
    expect(stickyPastDomains([{ ...mon("HTTP 404 · DEPLOYMENT_NOT_FOUND"), appMeta: { teamId: "t" } }], [{ ...app, meta: { teamId: "t" } }]).size).toBe(0);
  });
  it("DNF, then a timeout, then DNF: the move stays", () => {
    let meta: Record<string, unknown> = { domains: ["finance.example.com"], primaryDomain: "finance.example.com" };
    const seen: (string | null)[] = [];
    for (const lastError of ["HTTP 404 · DEPLOYMENT_NOT_FOUND", "Timed out after 10 s", "HTTP 404 · DEPLOYMENT_NOT_FOUND"]) {
      const m = { id: "m1", kind: "http", url: "https://old-finance.example.net/", appId: "a1", appName: "shopfront", appMeta: meta, lastError };
      const add = stickyPastDomains([m], [{ id: "a1", name: "shopfront", meta }]).get("a1");
      if (add) meta = { ...meta, pastDomains: add };
      seen.push(domainMove(m.url, { name: "shopfront", meta }, [], { lastError })?.to ?? null);
    }
    expect(seen).toEqual(["finance.example.com", "finance.example.com", "finance.example.com"]);
  });
});

describe("review T3 minors", () => {
  it("M1: another watched app's vercel.app names aren't this app's aliases", () => {
    const shop = { name: "shop", meta: { domains: ["shop.example.com"], primaryDomain: "shop.example.com" } };
    const admin = { name: "shop-admin", meta: { domains: [], primaryDomain: "shop-admin.example.com" } };
    expect(hostAttached("shop-admin.vercel.app", shop, [admin])).toBe(false);
    expect(hostAttached("shop-admin-git-main-team.vercel.app", shop, [admin])).toBe(false);
    expect(hostAttached("shop-git-main-team.vercel.app", shop, [admin])).toBe(true);
  });
  it("M4: movedUrl uses https and refuses a host it can't set", () => {
    expect(movedUrl("http://old.example.com/a?b=1", "new.example.com")).toBe("https://new.example.com/a?b=1");
    expect(() => movedUrl("https://old.example.com/", "bad host/")).toThrow();
  });
});
