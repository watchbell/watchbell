import { describe, expect, it } from "vitest";
import { factsOf, rdapFact, tlsFact } from "./facts";

const now = new Date("2026-10-12T15:00:00Z");

describe("factsOf", () => {
  it("reads every key it knows and ignores junk", () => {
    const f = factsOf({
      tls: { notAfter: "2026-12-09T23:59:59.000Z", issuer: "Let's Encrypt", authorized: true, error: null, checkedAt: "2026-10-12T03:20:00.000Z" },
      records: [{ id: "r", type: "A", name: "example.com", content: "76.76.21.21", proxied: false, ttl: 1, comment: null }, { broken: true }],
      zone: { status: "active", paused: false, nameServers: ["ada.ns.cloudflare.com"], accountId: "acc", checkedAt: "2026-10-12T14:00:00.000Z" },
      ssl: { mode: null, error: "The token can't read this." },
      vercel: "nonsense",
    });
    expect(f.tls?.issuer).toBe("Let's Encrypt");
    expect(f.records).toHaveLength(1);
    expect(f.zone?.status).toBe("active");
    expect(f.ssl).toEqual({ mode: null, error: "The token can't read this." });
    expect(f.vercel).toBeNull();
    expect(f.certs).toEqual([]);
  });
  it("an empty or missing snapshot reads as nothing known", () => {
    expect(factsOf(undefined)).toMatchObject({ tls: null, vercel: null, rdap: null, records: [], zone: null, ssl: null, reasons: [] });
  });
});

describe("tlsFact", () => {
  it("a read certificate replaces the old fact", () => {
    expect(tlsFact({ ok: true, notAfter: new Date("2026-12-09T23:59:59Z"), issuer: "R11", authorized: true, authError: null }, null, now))
      .toEqual({ notAfter: "2026-12-09T23:59:59.000Z", issuer: "R11", authorized: true, error: null, checkedAt: now.toISOString() });
  });
  it("a failed read keeps the last known expiry and issuer, with the error", () => {
    const prev = { notAfter: "2026-12-09T23:59:59.000Z", issuer: "R11", authorized: true, error: null, checkedAt: "2026-10-11T03:00:00.000Z" };
    expect(tlsFact({ ok: false, error: "Couldn't connect" }, prev, now))
      .toEqual({ notAfter: "2026-12-09T23:59:59.000Z", issuer: "R11", authorized: null, error: "Couldn't connect", checkedAt: now.toISOString() });
  });
});

describe("rdapFact", () => {
  it("an answer replaces the old fact; a failure keeps the last known date with the error", () => {
    expect(rdapFact({ ok: true, expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia" }, null, now))
      .toEqual({ expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia", error: null, checkedAt: now.toISOString() });
    const prev = { expiresAt: "2027-06-24T23:59:59.000Z", registrar: "PT JC Indonesia", error: null, checkedAt: "2026-10-11T03:00:00.000Z" };
    expect(rdapFact({ ok: false, error: "The registry's RDAP server returned an error (503)" }, prev, now))
      .toEqual({ ...prev, error: "The registry's RDAP server returned an error (503)", checkedAt: now.toISOString() });
  });
});
