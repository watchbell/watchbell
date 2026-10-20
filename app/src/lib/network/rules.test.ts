import { describe, expect, it } from "vitest";
import {
  daysLeft, domainState, dueForRefresh, edgeCertSummary, isoDate, isVercelHost, networkEvent, pointsToVercel,
  recordsFor, sslModeLabel, vercelProxied, zoneFor, zoneState, type DnsRecord, type RdapFact, type TlsFact, type VercelFact,
} from "./rules";

const now = new Date("2026-10-12T15:00:00Z");
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const rec = (p: Partial<DnsRecord>): DnsRecord => ({ id: "r", type: "CNAME", name: "app.example.com", content: "x.vercel-dns-017.com", proxied: false, ttl: 1, comment: null, ...p });
const tls = (p: Partial<TlsFact> = {}): TlsFact => ({ notAfter: inDays(60), issuer: "Let's Encrypt", authorized: true, error: null, checkedAt: now.toISOString(), ...p });
const vercel = (p: Partial<VercelFact> = {}): VercelFact => ({ misconfigured: false, configuredBy: "CNAME", recommendedIps: [], checkedAt: now.toISOString(), ...p });
const rdap = (p: Partial<RdapFact> = {}): RdapFact => ({ expiresAt: inDays(200), registrar: "PT JC Indonesia", error: null, checkedAt: now.toISOString(), ...p });

describe("dates", () => {
  it("isoDate reads ISO strings and Dates, and nothing else", () => {
    expect(isoDate("2027-06-24T23:59:59Z")?.toISOString()).toBe("2027-06-24T23:59:59.000Z");
    expect(isoDate(new Date(0))?.getTime()).toBe(0);
    expect(isoDate("soon")).toBeNull();
    expect(isoDate(null)).toBeNull();
    expect(isoDate(42)).toBeNull();
  });
  it("daysLeft floors, goes negative after the date, and is null without one", () => {
    expect(daysLeft(new Date(inDays(12.9)), now)).toBe(12);
    expect(daysLeft(new Date(inDays(-0.5)), now)).toBe(-1);
    expect(daysLeft(null, now)).toBeNull();
  });
  it("dueForRefresh: never checked, or checked 20 h ago or more", () => {
    expect(dueForRefresh(undefined, now)).toBe(true);
    expect(dueForRefresh(new Date(now.getTime() - 19 * 3_600_000).toISOString(), now)).toBe(false);
    expect(dueForRefresh(new Date(now.getTime() - 20 * 3_600_000).toISOString(), now)).toBe(true);
  });
});

describe("hosts and records", () => {
  it("knows Vercel's own hosts", () => {
    expect(isVercelHost("acme-shop.vercel.app")).toBe(true);
    expect(isVercelHost("vercel.app.example.com")).toBe(false);
  });
  it("zoneFor picks the longest zone the host sits in", () => {
    expect(zoneFor("ops.example.web.id", ["web.id", "example.web.id"])).toBe("example.web.id");
    expect(zoneFor("EXAMPLE.WEB.ID.", ["example.web.id"])).toBe("example.web.id");
    expect(zoneFor("evilexample.web.id", ["example.web.id"])).toBeNull();
    expect(zoneFor("x.vercel.app", ["example.web.id"])).toBeNull();
  });
  it("recordsFor matches the FQDN Cloudflare returns, case-insensitively", () => {
    const list = [rec({ name: "ops.example.web.id" }), rec({ name: "OPS.example.web.id", type: "TXT", content: "v" }), rec({ name: "www.example.web.id" })];
    expect(recordsFor("ops.example.web.id", list)).toHaveLength(2);
  });
  it("pointsToVercel: Vercel CNAME targets and A records on Vercel's IPs", () => {
    expect(pointsToVercel({ type: "CNAME", content: "d1a2b3.vercel-dns-017.com" })).toBe(true);
    expect(pointsToVercel({ type: "CNAME", content: "cname.vercel-dns.com." })).toBe(true);
    expect(pointsToVercel({ type: "A", content: "76.76.21.21" })).toBe(true);
    expect(pointsToVercel({ type: "A", content: "216.198.79.1" }, ["216.198.79.1"])).toBe(true);
    expect(pointsToVercel({ type: "A", content: "1.2.3.4" })).toBe(false);
    expect(pointsToVercel({ type: "CNAME", content: "vercel-dns.com.evil.net" })).toBe(false);
    expect(pointsToVercel({ type: "TXT", content: "76.76.21.21" })).toBe(false);
  });
  it("vercelProxied lists only proxied records that point to Vercel", () => {
    const list = [rec({ id: "a", proxied: true }), rec({ id: "b", proxied: false }), rec({ id: "c", proxied: true, content: "origin.example.net" })];
    expect(vercelProxied(list).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("labels", () => {
  it("sslModeLabel follows Cloudflare's names; null stays null", () => {
    expect(sslModeLabel("strict")).toBe("Full (strict)");
    expect(sslModeLabel("full")).toBe("Full");
    expect(sslModeLabel("flexible")).toBe("Flexible");
    expect(sslModeLabel("off")).toBe("Off");
    expect(sslModeLabel("origin_pull")).toBe("Strict (origin pull)");
    expect(sslModeLabel("new_mode")).toBe("new_mode");
    expect(sslModeLabel(null)).toBeNull();
  });
  it("edgeCertSummary prefers the universal pack and reads its soonest expiry", () => {
    expect(edgeCertSummary([
      { type: "advanced", status: "pending_validation", hosts: [], expiresOn: null },
      { type: "universal", status: "active", hosts: ["example.com"], expiresOn: "2026-12-09T00:00:00Z" },
    ])).toEqual({ state: "ok", label: "Universal · active", expiresOn: "2026-12-09T00:00:00Z" });
    expect(edgeCertSummary([{ type: "universal", status: "pending_validation", hosts: [], expiresOn: null }]).state).toBe("warn");
    expect(edgeCertSummary([{ type: "universal", status: "expired", hosts: [], expiresOn: null }]).state).toBe("err");
    expect(edgeCertSummary([])).toEqual({ state: "unknown", label: "No edge certificate found", expiresOn: null });
  });
});

describe("zoneState", () => {
  it("active and far from expiry is ok", () => {
    expect(zoneState({ status: "active", paused: false, rdap: rdap() }, now)).toEqual({ state: "ok", reasons: [] });
  });
  it("pending, paused, moved and near expiry say why", () => {
    expect(zoneState({ status: "pending", paused: false, rdap: rdap() }, now).state).toBe("warn");
    expect(zoneState({ status: "active", paused: true, rdap: rdap() }, now).reasons).toContain("Cloudflare is paused for this zone");
    expect(zoneState({ status: "moved", paused: false, rdap: rdap() }, now).state).toBe("err");
    expect(zoneState({ status: "active", paused: false, rdap: rdap({ expiresAt: inDays(20) }) }, now))
      .toEqual({ state: "warn", reasons: ["Domain expires in 20 days"] });
    expect(zoneState({ status: "active", paused: false, rdap: rdap({ expiresAt: inDays(-1) }) }, now).state).toBe("err");
  });
  it("no RDAP answer doesn't make a zone ok or bad on its own", () => {
    expect(zoneState({ status: "active", paused: false, rdap: rdap({ expiresAt: null, error: "The registry has no RDAP server" }) }, now).state).toBe("ok");
    expect(zoneState({ status: null, paused: false, rdap: null }, now).state).toBe("unknown");
  });
});

describe("domainState", () => {
  const base = { host: "app.example.com", tls: tls(), vercel: vercel(), records: [rec({})], zoneRdap: rdap() };
  it("all good is ok", () => expect(domainState(base, now)).toEqual({ state: "ok", reasons: [] }));
  it("warns on a certificate under 14 days, a proxied Vercel record, a misconfigured domain and a domain expiring in 30 days", () => {
    expect(domainState({ ...base, tls: tls({ notAfter: inDays(12) }) }, now)).toEqual({ state: "warn", reasons: ["Certificate expires in 12 days"] });
    expect(domainState({ ...base, records: [rec({ proxied: true })] }, now).reasons).toEqual(["Proxied by Cloudflare in front of Vercel"]);
    expect(domainState({ ...base, vercel: vercel({ misconfigured: true }) }, now).reasons).toEqual(["Vercel says the DNS is misconfigured"]);
    expect(domainState({ ...base, zoneRdap: rdap({ expiresAt: inDays(29) }) }, now).reasons).toEqual(["Domain expires in 29 days"]);
  });
  it("an expired or untrusted certificate is err; a failed handshake is warn with the reason", () => {
    expect(domainState({ ...base, tls: tls({ notAfter: inDays(-2) }) }, now).state).toBe("err");
    expect(domainState({ ...base, tls: tls({ authorized: false, error: null }) }, now)).toEqual({ state: "err", reasons: ["Certificate isn't trusted"] });
    expect(domainState({ ...base, tls: tls({ notAfter: null, error: "No answer within 5 s" }) }, now))
      .toEqual({ state: "warn", reasons: ["TLS check failed: No answer within 5 s"] });
  });
  it("a vercel.app host is Vercel's: no TLS or zone needed", () => {
    expect(domainState({ host: "x.vercel.app", tls: null, vercel: null, records: [], zoneRdap: null }, now).state).toBe("ok");
  });
  it("a custom domain with nothing read yet is unknown", () => {
    expect(domainState({ host: "app.example.com", tls: null, vercel: null, records: [], zoneRdap: null }, now)).toEqual({ state: "unknown", reasons: [] });
  });
});

describe("networkEvent", () => {
  const at = now;
  it("only on a change after the first reading", () => {
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: null, next: "warn", reasons: ["x"], at })).toBeNull();
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: "unknown", next: "warn", reasons: ["x"], at })).toBeNull();
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: "ok", next: "ok", reasons: [], at })).toBeNull();
  });
  it("names the domain and the reasons", () => {
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: "ok", next: "warn", reasons: ["Certificate expires in 12 days"], at }))
      .toEqual({ resourceId: "d", type: "system", reason: "NetworkAttention", kind: "warn", message: "app.example.com needs attention", detail: "Certificate expires in 12 days", at });
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: "warn", next: "ok", reasons: [], at })?.message).toBe("app.example.com is fine again");
    expect(networkEvent({ resourceId: "d", name: "app.example.com", prev: "ok", next: "err", reasons: ["Certificate expired 2 days ago"], at })?.kind).toBe("err");
  });
});
