import { describe, expect, it } from "vitest";
import { RULE_KEYS, RULES, type RuleConfig } from "./catalog";
import { evaluate } from "./evaluate";
import type { Facts } from "./facts";
import { dbFact, dnsFacts, domainFacts } from "./facts-map";

// Fixtures are shaped like what stages 3 and 4 really write to ops.snapshots.data (db-tasks.ts, network.ts), so a
// renamed field breaks these tests instead of silently turning a rule off.
const now = new Date("2026-10-13T12:00:00Z"); // 05:00 in Los Angeles: today's Firestore quota started at 07:00 UTC
const DAY = 86_400_000;
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(now.getTime() + days * DAY).toISOString();

const supabase = (state: "ok" | "paused" | "unknown", data: Record<string, unknown>) => ({ id: "s1", name: "quillpad", kind: "supabase_project", state, data: {
  status: state === "paused" ? "INACTIVE" : "ACTIVE_HEALTHY", region: "ap-southeast-1", pgVersion: "15.8", orgSlug: "acme", freeOrg: true,
  health: [{ name: "db", status: "ACTIVE_HEALTHY" }], healthAt: ago(0), healthError: null, ...data,
} });
const neon = (data: Record<string, unknown>) => ({ id: "n1", name: "ticketer", kind: "neon_project", state: "idle" as const, data: {
  region: "aws-ap-southeast-1", pgVersion: 17, orgId: "org-1", transferBytes: 12e6, periodStart: ago(12), periodEnd: ahead(18),
  endpoints: [{ id: "ep-1", branchId: "br-main", state: "idle", pendingState: null, disabled: false, minCu: 0.25, maxCu: 0.25, lastActive: ago(1) }],
  ...data,
} });
const firestore = (data: Record<string, unknown>) => ({ id: "f1", name: "orbit-blog", kind: "firestore", state: "ok" as const, data: { displayName: "orbit-blog", ...data } });

const zone = (data: Record<string, unknown>) => ({ id: "z1", name: "example.com", kind: "zone", state: "ok" as const, data: {
  zone: { status: "active", paused: false, nameServers: ["ada.ns.cloudflare.com"], accountId: "cf-acc", checkedAt: ago(0) },
  ssl: { mode: "strict", error: null }, cfErrors: [], recordsTruncated: false, certs: [], reasons: [], ...data,
} });
const domain = (id: string, name: string, data: Record<string, unknown>) => ({ id, name, kind: "domain", state: "ok" as const, data: { reasons: [], ...data } });
const record = (o: Record<string, unknown>) => ({ id: "rec-1", type: "CNAME", name: "tiket.example.com", content: "cname.vercel-dns.com", proxied: false, ttl: 1, comment: null, ...o });
const tls = (notAfter: string | null, error: string | null = null) => ({ notAfter, issuer: "R11", authorized: error ? null : true, error, checkedAt: ago(0) });

describe("dbFact (stage 3 snapshot data)", () => {
  it("reads Supabase size, paused state and last API traffic", () => {
    expect(dbFact(supabase("paused", { sizeBytes: 211e6, sizeAt: ago(1), lastTrafficAt: ago(5), trafficAt: ago(0), trafficError: null }), now))
      .toMatchObject({ provider: "supabase", state: "paused", sizeBytes: 211e6, sizeLimitBytes: 500 * 1024 * 1024, lastApiAt: new Date(ago(5)) });
  });
  it("treats a traffic read without any traffic as idle for the whole 7-day window, and an unread one as unknown", () => {
    expect(dbFact(supabase("ok", { lastTrafficAt: null, trafficAt: ago(0), trafficError: null }), now)?.lastApiAt).toEqual(new Date(ago(7)));
    expect(dbFact(supabase("ok", {}), now)?.lastApiAt).toBeNull();
    expect(dbFact(supabase("ok", { lastTrafficAt: null, trafficAt: ago(0), trafficError: "HTTP 500" }), now)?.lastApiAt).toBeNull();
  });
  it("turns Neon compute seconds into CU-hours and sums the branches' logical sizes", () => {
    const f = dbFact(neon({ computeSeconds: 306_000, branches: [{ id: "br-main", name: "main", isDefault: true, logicalSize: 600e6 }, { id: "br-dev", name: "dev", isDefault: false, logicalSize: 300e6 }] }), now);
    expect(f).toMatchObject({ provider: "neon", cuHours: 85, cuLimit: 100, sizeBytes: 900e6, sizeLimitBytes: 1024 ** 3 });
    expect(dbFact(neon({}), now)).toMatchObject({ cuHours: null, sizeBytes: null });
  });
  it("counts Firestore reads only when they were read after today's quota reset", () => {
    expect(dbFact(firestore({ latencyMs: 120, pingError: null, pingReason: null, reads: 41_000, writes: 10, deletes: 0, opsAt: "2026-10-13T11:00:00Z" }), now))
      .toMatchObject({ provider: "firestore", readsToday: 41_000, readsLimit: 50_000, quotaExhausted: false });
    expect(dbFact(firestore({ latencyMs: 120, reads: 41_000, opsAt: "2026-10-13T06:00:00Z" }), now)?.readsToday).toBeNull(); // yesterday's count
    expect(dbFact(firestore({ pingError: "Quota exceeded", pingReason: "RESOURCE_EXHAUSTED", pingKind: "transient" }), now)?.quotaExhausted).toBe(true);
    expect(dbFact(firestore({}), now)?.quotaExhausted).toBeNull(); // never pinged
  });
  it("ignores other kinds and bad values", () => {
    expect(dbFact({ id: "x", name: "x", kind: "app", state: "ok", data: {} }, now)).toBeNull();
    expect(dbFact(supabase("ok", { sizeBytes: "big", lastTrafficAt: "not a date" }), now)).toMatchObject({ sizeBytes: null, lastApiAt: null });
  });
});

describe("domainFacts and dnsFacts (stage 4 snapshot data)", () => {
  it("takes RDAP expiry from the zone and the certificate from each domain row", () => {
    const z = zone({ rdap: { expiresAt: ahead(20), registrar: "Cloudflare", error: null, checkedAt: ago(0) } });
    const d = domain("d1", "tiket.example.com", { tls: tls(ahead(10)), vercel: { misconfigured: false, configuredBy: "CNAME", recommendedIps: [], checkedAt: ago(0) } });
    expect(domainFacts([z], [d])).toEqual([
      { id: "z1", name: "example.com", tlsNotAfter: null, expiresAt: new Date(ahead(20)) },
      { id: "d1", name: "tiket.example.com", tlsNotAfter: new Date(ahead(10)), expiresAt: null },
    ]);
    expect(domainFacts([], [])).toBeNull();
  });
  it("keeps the last good certificate date through a failed TLS read, and reads nothing from junk", () => {
    expect(domainFacts([], [domain("d1", "a.example.com", { tls: tls(ahead(40), "timeout") })])?.[0].tlsNotAfter).toEqual(new Date(ahead(40)));
    expect(domainFacts([zone({ rdap: "junk" })], [domain("d1", "a.example.com", { tls: { notAfter: 5 } })])).toEqual([
      { id: "z1", name: "example.com", tlsNotAfter: null, expiresAt: null },
      { id: "d1", name: "a.example.com", tlsNotAfter: null, expiresAt: null },
    ]);
  });
  it("derives one DNS subject per record that points to Vercel, on the matching domain row or else the zone", () => {
    const z = zone({ records: [
      record({ id: "rec-1", name: "tiket.example.com", proxied: true }),
      record({ id: "rec-2", type: "A", name: "example.com", content: "76.76.21.21", proxied: false }),
      record({ id: "rec-3", type: "A", name: "old.example.com", content: "203.0.113.9", proxied: true }), // custom IP from Vercel's config
      record({ id: "rec-4", type: "MX", name: "example.com", content: "mx.example.net", proxied: false }),
    ] });
    const d = domain("d1", "tiket.example.com", { vercel: { misconfigured: false, configuredBy: "CNAME", recommendedIps: ["203.0.113.9"], checkedAt: ago(0) } });
    expect(dnsFacts([z], [d])).toEqual([
      { id: "z1:rec-1", resourceId: "d1", name: "tiket.example.com", proxied: true, pointsToVercel: true },
      { id: "z1:rec-2", resourceId: "z1", name: "example.com", proxied: false, pointsToVercel: true },
      { id: "z1:rec-3", resourceId: "z1", name: "old.example.com", proxied: true, pointsToVercel: true },
    ]);
  });
  it("is null until some zone's records were read", () => {
    expect(dnsFacts([zone({})], [])).toBeNull();
    expect(dnsFacts([], [domain("d1", "a.example.com", {})])).toBeNull();
    expect(dnsFacts([zone({ records: [] })], [])).toEqual([]);
  });
});

describe("stage 3 and 4 snapshots fire the database, domain and DNS rules", () => {
  const rules: RuleConfig[] = RULE_KEYS.map((key) => ({ key, severity: RULES[key].severity, threshold: RULES[key].threshold, enabled: true, channels: ["telegram"] }));
  const facts = (dbRows: ReturnType<typeof supabase | typeof neon | typeof firestore>[], zones: ReturnType<typeof zone>[], domains: ReturnType<typeof domain>[]): Facts => ({
    now, lastMinuteRunAt: now, monitors: [], apps: [], accounts: [], links: [],
    dbs: dbRows.map((r) => dbFact(r, now)).filter((x) => x !== null), domains: domainFacts(zones, domains), dns: dnsFacts(zones, domains),
  });
  const status = (f: Facts, rule: string, subject: string) => evaluate(f, rules).observations.find((o) => o.rule === rule && o.subject === subject)?.status;

  it("fires every database rule from real field names", () => {
    const f = facts([
      supabase("paused", { sizeBytes: 450 * 1024 * 1024, lastTrafficAt: ago(9), trafficAt: ago(1) }),
      neon({ computeSeconds: 85 * 3600, branches: [{ id: "br-main", name: "main", isDefault: true, logicalSize: 900 * 1024 ** 2 }] }),
      firestore({ latencyMs: 90, reads: 45_000, opsAt: "2026-10-13T11:30:00Z" }),
    ], [], []);
    expect(status(f, "DatabasePaused", "s1")).toBe("firing");
    expect(status(f, "StorageAlmostFull", "s1")).toBe("firing");
    expect(status(f, "StorageAlmostFull", "n1")).toBe("firing");
    expect(status(f, "NeonComputeHigh", "n1")).toBe("firing");
    expect(status(f, "FirestoreQuotaHigh", "f1")).toBe("firing");
    const idle = facts([supabase("ok", { lastTrafficAt: ago(5), trafficAt: ago(0) })], [], []);
    expect(status(idle, "AutoPauseRisk", "s1")).toBe("firing");
    expect(status(idle, "DatabasePaused", "s1")).toBe("ok");
  });

  it("fires the certificate, domain and DNS rules from real field names", () => {
    const z = zone({ rdap: { expiresAt: ahead(20), registrar: "Cloudflare", error: null, checkedAt: ago(0) }, records: [record({ proxied: true })] });
    const d = domain("d1", "tiket.example.com", { tls: tls(ahead(10)) });
    const f = facts([], [z], [d]);
    expect(status(f, "DomainExpiringSoon", "z1")).toBe("firing");
    expect(status(f, "CertExpiringSoon", "d1")).toBe("firing");
    expect(status(f, "DnsProxiedToVercel", "z1:rec-1")).toBe("firing");
    const fine = facts([], [zone({ rdap: { expiresAt: ahead(200), registrar: null, error: null, checkedAt: ago(0) }, records: [record({})] })], [domain("d1", "tiket.example.com", { tls: tls(ahead(60)) })]);
    expect(status(fine, "DomainExpiringSoon", "z1")).toBe("ok");
    expect(status(fine, "CertExpiringSoon", "d1")).toBe("ok");
    expect(status(fine, "DnsProxiedToVercel", "z1:rec-1")).toBe("ok");
  });
});
