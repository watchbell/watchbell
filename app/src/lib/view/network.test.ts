import { describe, expect, it } from "vitest";
import type { DnsRecord, RdapFact, TlsFact, VercelFact } from "@/lib/network/rules";
import { certCell, cloudflareCell, dnsCell, expiryCell, proxiedBannerText, ttlText, vercelCell, zoneStatusLabel } from "./network";

const now = new Date("2026-10-12T15:00:00Z");
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const rdap = (p: Partial<RdapFact> = {}): RdapFact => ({ expiresAt: "2027-03-14T00:00:00.000Z", registrar: "PT Contoh", error: null, checkedAt: now.toISOString(), ...p });
const tls = (p: Partial<TlsFact> = {}): TlsFact => ({ notAfter: inDays(61), issuer: "Let's Encrypt", authorized: true, error: null, checkedAt: new Date(now.getTime() - 3_600_000).toISOString(), ...p });
const rec = (p: Partial<DnsRecord>): DnsRecord => ({ id: "r", type: "CNAME", name: "tiket.example.com", content: "d5e6f7.vercel-dns-017.com", proxied: false, ttl: 1, comment: null, ...p });

describe("expiryCell", () => {
  it("shows the RDAP date and days left; under 30 days warns", () => {
    expect(expiryCell(rdap(), "example.com", false, now)).toEqual({ text: "14 Mar 2027", sub: "in 152 days", state: null });
    expect(expiryCell(rdap({ expiresAt: inDays(20) }), "example.com", false, now).state).toBe("warn");
  });
  it("Vercel's own hosts, hosts outside a watched zone, and registries without RDAP", () => {
    expect(expiryCell(null, null, true, now)).toEqual({ text: "Vercel's domain", sub: null, state: null });
    expect(expiryCell(null, null, false, now)).toEqual({ text: "Unknown", sub: "Not in a watched Cloudflare zone", state: "unknown" });
    expect(expiryCell(null, "example.com", false, now)).toEqual({ text: "Unknown", sub: "Not read yet", state: "unknown" });
    expect(expiryCell(rdap({ expiresAt: null, error: "The registry has no RDAP server" }), "example.net", false, now))
      .toEqual({ text: "Unknown", sub: "The registry has no RDAP server", state: "unknown" });
  });
});

describe("certCell", () => {
  it("days left, issuer and when it was checked", () => {
    // ago(): past the first hour it reads the WIB clock time (14:00 UTC = 21:00 WIB).
    expect(certCell(tls(), false, now)).toEqual({ text: "61 days left", sub: "Let's Encrypt · checked today 21:00", state: "ok" });
    expect(certCell(tls({ notAfter: inDays(12) }), false, now).state).toBe("warn");
    expect(certCell(tls({ notAfter: inDays(-1) }), false, now)).toMatchObject({ text: "Expired 1 day ago", state: "err" });
  });
  it("a failed check, nothing yet, and Vercel's hosts", () => {
    expect(certCell(tls({ error: "Couldn't connect" }), false, now)).toMatchObject({ text: "Check failed", sub: "Couldn't connect", state: "warn" });
    expect(certCell(null, false, now)).toEqual({ text: "Not checked yet", sub: "The first check runs within a day", state: "unknown" });
    expect(certCell(null, true, now)).toEqual({ text: "Managed by Vercel", sub: null, state: null });
  });
});

describe("dnsCell, vercelCell, ttlText, zoneStatusLabel", () => {
  it("dnsCell shows the address record and flags a proxied Vercel target", () => {
    expect(dnsCell([rec({ proxied: true }), rec({ type: "TXT", content: "x" })], false, "example.com", []))
      .toEqual({ text: "CNAME → d5e6f7.vercel-dns-017.com", proxiedToVercel: true });
    expect(dnsCell([], true, null, [])).toEqual({ text: "Managed by Vercel", proxiedToVercel: false });
    expect(dnsCell([], false, null, [])).toEqual({ text: "Not in a watched Cloudflare zone", proxiedToVercel: false });
    expect(dnsCell([], false, "example.com", [])).toEqual({ text: "No address record in the zone", proxiedToVercel: false });
  });
  it("vercelCell", () => {
    const v = (p: Partial<VercelFact>): VercelFact => ({ misconfigured: false, configuredBy: "CNAME", recommendedIps: [], checkedAt: now.toISOString(), ...p });
    expect(vercelCell(v({}), false)).toEqual({ state: "ok", label: "Valid" });
    expect(vercelCell(v({ misconfigured: true }), false)).toEqual({ state: "warn", label: "Misconfigured" });
    expect(vercelCell(null, false)).toEqual({ state: "unknown", label: "Not read yet" });
    expect(vercelCell(null, true)).toEqual({ state: "ok", label: "Valid" });
  });
  it("ttlText", () => {
    expect([1, 60, 300, 3600, 7200, 45].map(ttlText)).toEqual(["Auto", "1 min", "5 min", "1 h", "2 h", "45 s"]);
  });
  it("proxiedBannerText follows the mockup, with or without a known certificate", () => {
    expect(proxiedBannerText(12)).toBe("Vercel recommends DNS only (grey cloud) for records that point to Vercel. Proxying can stop certificate renewal, and this certificate expires in 12 days.");
    expect(proxiedBannerText(null)).toBe("Vercel recommends DNS only (grey cloud) for records that point to Vercel. Proxying can stop certificate renewal.");
  });
  it("zoneStatusLabel", () => {
    expect(zoneStatusLabel("active", false)).toEqual({ state: "ok", label: "Active" });
    expect(zoneStatusLabel("active", true)).toEqual({ state: "warn", label: "Active · paused" });
    expect(zoneStatusLabel("pending", false)).toEqual({ state: "warn", label: "Pending" });
    expect(zoneStatusLabel("moved", false)).toEqual({ state: "err", label: "Moved" });
    expect(zoneStatusLabel(null, false)).toEqual({ state: "unknown", label: "Not read yet" });
  });
});

describe("cloudflareCell (Overview status strip)", () => {
  it("counts only domains in a watched zone and takes the worst state", () => {
    expect(cloudflareCell([])).toEqual({ state: "unknown", sub: "No domains in a watched zone yet" });
    expect(cloudflareCell([{ state: "err", zoneName: null }])).toEqual({ state: "unknown", sub: "No domains in a watched zone yet" });
    expect(cloudflareCell([{ state: "ok", zoneName: "a.id" }, { state: "warn", zoneName: "a.id" }])).toEqual({ state: "warn", sub: "2 domains · 1 needs attention" });
  });
  it("never shows a domain nobody has read as ok", () => {
    expect(cloudflareCell([{ state: "ok", zoneName: "a.id" }, { state: "unknown", zoneName: "a.id" }])).toEqual({ state: "unknown", sub: "2 domains · 1 not read yet" });
  });
});
