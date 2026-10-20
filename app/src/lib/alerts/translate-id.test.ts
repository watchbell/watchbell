import { describe, expect, it } from "vitest";
import type { MetricsLatest } from "@/lib/databases/compute-metrics";
import { RULE_KEYS, RULES, type RuleConfig, type RuleKey } from "./catalog";
import { evaluate } from "./evaluate";
import type { DbFact, Facts } from "./facts";
import { translateAlertText } from "./translate-id";

// The translator works on the real English the evaluators write: every rule gets at least one firing fixture here, so
// a new rule or a reworded message shows up as a failing test instead of an English line in an Indonesian alert.
const now = new Date("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
const rules: RuleConfig[] = RULE_KEYS.map((key) => ({ key, severity: RULES[key].severity, threshold: RULES[key].threshold, enabled: true, channels: ["telegram"] }));
const mon = (o: Partial<Facts["monitors"][number]>): Facts["monitors"][number] => ({
  id: "m", appId: "a1", appName: "app-a", url: "https://app-a.example.com/health", kind: "http", state: "err", failStreak: 3, lastStatus: 502,
  lastError: "HTTP 502", lastCheckedAt: now, p95Last10: 300, checksLast10: 10, ...o,
});
const hb = (id: string, lastError: string | null) => mon({ id, kind: "heartbeat", url: "backup job", lastStatus: null, lastError });
const db = (o: Partial<DbFact> & Pick<DbFact, "id" | "name" | "provider">): DbFact => ({
  state: "ok", sizeBytes: null, sizeLimitBytes: null, lastApiAt: null, cuHours: null, cuLimit: null, readsToday: null, readsLimit: null, quotaExhausted: null, ...o,
});
const latest = (o: Partial<MetricsLatest>): MetricsLatest => ({ at: at(2), cpuPct: 10, memPct: 40, diskPct: 20, connUsed: 10, connMax: 60, prev: null, recent: [], ...o });
const vuln = (o: Partial<NonNullable<Facts["deps"]>[number]["vulns"][number]> = {}) => ({ package: "next", installedVersion: "15.0.0", fixedVersion: "15.2.3", severity: "high" as const, summary: "", dev: false, ...o });

const facts = (o: Partial<Facts>): Facts => ({
  now, lastMinuteRunAt: new Date(now.getTime() - 60_000), monitors: [], apps: [], accounts: [], dbs: null, domains: null, dns: null, links: [], ...o,
});

// Several fixtures per rule where the evaluator has several message shapes.
const FIXTURES: Facts[] = [
  facts({
    monitors: [
      mon({ id: "502" }), mon({ id: "none", lastStatus: null, lastError: "fetch failed" }), mon({ id: "kw", lastStatus: 200, lastError: "Keyword not found" }),
      hb("f", "Down · the job reported a failure"), hb("s", "Down · started but didn't finish"), hb("n", "Down · no ping for 2 h"),
      hb("d", "Down · no ping for 3 days"), hb("v", "Down · never pinged"), hb("x", null),
      mon({ id: "slow", state: "ok", failStreak: 0, lastStatus: 200, lastError: null, p95Last10: 1800 }),
    ],
    lastMinuteRunAt: new Date(now.getTime() - 12 * 60_000),
    apps: [
      { id: "a1", name: "app-a", latestProduction: { state: "error", sha: "0d3c8aa1", createdAt: now } },
      { id: "a2", name: "app-b", latestProduction: { state: "error", sha: null, createdAt: now } },
    ],
    dbs: [
      db({ id: "s1", name: "db-a", provider: "supabase", state: "paused", sizeBytes: 450e6, sizeLimitBytes: 500e6 }),
      db({ id: "s2", name: "db-b", provider: "supabase", lastApiAt: new Date(now.getTime() - 5 * DAY) }),
      db({ id: "s3", name: "db-c", provider: "supabase", lastApiAt: new Date(now.getTime() - 1 * DAY) }),
      db({ id: "n1", name: "db-d", provider: "neon", cuHours: 85, cuLimit: 100 }),
      db({ id: "f1", name: "db-e", provider: "firestore", readsToday: 41_000, readsLimit: 50_000, quotaExhausted: false }),
      db({ id: "f2", name: "db-f", provider: "firestore", quotaExhausted: true }),
      db({ id: "t1", name: "db-g", provider: "turso", quotaPct: 91, quotaLabel: null }),
      db({ id: "t2", name: "db-i", provider: "turso", quotaPct: 93, quotaLabel: "Rows read of 500M this month (org)" }),
      db({ id: "u1", name: "db-h", provider: "upstash", quotaPct: 85, quotaLabel: "Commands of 500k this month" }),
      db({ id: "c1", name: "db-j", provider: "d1", quotaPct: 88, quotaLabel: "Rows written today of 100k (account)" }),
    ],
    domains: [
      { id: "d1", name: "app-a.example.com", tlsNotAfter: new Date(now.getTime() + 12.5 * DAY), expiresAt: new Date(now.getTime() + 10.5 * DAY) },
      { id: "d2", name: "app-b.example.com", tlsNotAfter: new Date(now.getTime() + 1.5 * DAY), expiresAt: new Date(now.getTime() + 1.5 * DAY) },
      { id: "d3", name: "app-c.example.com", tlsNotAfter: new Date(now.getTime() - 1.5 * DAY), expiresAt: new Date(now.getTime() - 1.5 * DAY) },
    ],
    dns: [{ id: "z1:r1", resourceId: "d1", name: "app-a.example.com", proxied: true, pointsToVercel: true }],
    compute: [
      { id: "p1", name: "db-a", latest: latest({ memPct: 93, diskPct: 85, connUsed: 55, connMax: 60, recent: [15, 10, 5, 0].map((m) => ({ at: at(m), cpu: 92 })) }) },
    ],
    accounts: [
      { id: "c1", provider: "vercel", label: "acme", expiresAt: new Date(now.getTime() + 10.5 * DAY), status: "ok", lastError: null },
      { id: "c2", provider: "neon", label: "main key", expiresAt: new Date(now.getTime() + 1.5 * DAY), status: "ok", lastError: null },
      { id: "c3", provider: "github", label: "pat", expiresAt: new Date(now.getTime() - 2 * DAY), status: "ok", lastError: null },
      { id: "c4", provider: "drive", label: "acme", expiresAt: null, status: "error", lastError: "invalid_grant" },
    ],
    deps: [
      { appId: "a1", error: null, vulns: [vuln(), vuln({ package: "lodash", installedVersion: "4.17.20", fixedVersion: "4.17.21", severity: "critical" })] },
      { appId: "a2", error: null, vulns: [vuln({ fixedVersion: null }), ...["a", "b", "c", "d", "e"].map((p) => vuln({ package: `pkg-${p}` }))] },
    ],
  }),
  facts({ lastMinuteRunAt: null }),
];

const observations = FIXTURES.flatMap((f) => evaluate(f, rules).observations);
const firing = observations.filter((o) => o.status === "firing");
// Words that mean an English sentence slipped through (names, units and numbers are kept as they are).
const DENY = ["failed", "expires", "expired", "over the last", "returned", "consecutive", "limit", " the ", " is ", " uses ", " used ", " read ", "days", "today",
  "this month", "answers", "again", "hasn't", "points to", "recommends", "removed", "vulnerable", "packages", "no fix", " more", "about", "traffic for"];

describe("translateAlertText", () => {
  it("has a firing fixture for every rule", () => {
    const covered = new Set(firing.map((o) => o.rule));
    expect(RULE_KEYS.filter((k) => !covered.has(k))).toEqual([]);
  });

  it.each(firing.map((o) => [o.rule, o.message] as [RuleKey, string]))("%s: %s", (rule, message) => {
    const id = translateAlertText(rule, message);
    expect(id).not.toBe(message);
    for (const w of DENY) expect(id.toLowerCase(), `"${w}" left in: ${id}`).not.toContain(w);
  });

  it("speaks like the owner", () => {
    const one = (rule: RuleKey, subject: string) => translateAlertText(rule, observations.find((o) => o.rule === rule && o.subject === subject)!.message);
    expect(one("MonitorDown", "502")).toBe("app-a.example.com/health: 3 cek gagal berturut-turut (HTTP 502).");
    expect(one("MonitorDown", "none")).toBe("app-a.example.com/health: 3 cek gagal berturut-turut (nggak ada jawaban).");
    expect(one("MonitorDown", "kw")).toBe("app-a.example.com/health: 3 cek gagal berturut-turut (Keyword not found).");
    expect(one("MonitorDown", "n")).toBe("app-a · backup job: nggak ada ping selama 2 jam.");
    expect(one("MonitorDown", "d")).toBe("app-a · backup job: nggak ada ping selama 3 hari.");
    expect(one("HighLatency", "slow")).toBe("p95 1,800 ms selama 10 menit terakhir (batas 1,500 ms).");
    expect(one("CollectorStale", "collector")).toBe("Collector terakhir selesai jalan 12 menit lalu.");
    expect(one("StorageAlmostFull", "s1")).toBe("db-a pakai 450 MB dari 500 MB (90%).");
    expect(one("DomainExpiringSoon", "d1")).toBe("app-a.example.com habis dalam 10 hari.");
    expect(one("DomainExpiringSoon", "d3")).toBe("app-c.example.com udah habis.");
    expect(one("CredentialExpiring", "c3")).toBe("Credential github pat udah kedaluwarsa.");
    expect(one("DbQuotaHigh", "t1")).toBe("db-g: pemakaian udah 91% dari kuota gratis.");
    expect(one("DbQuotaHigh", "t2")).toBe("db-i: baris dibaca dari 500M bulan ini (org) udah 93% dari kuota gratis.");
    expect(one("DbQuotaHigh", "c1")).toBe("db-j: baris ditulis hari ini dari 100k (akun) udah 88% dari kuota gratis.");
    expect(one("ComputeHigh", "p1")).toBe("db-a: CPU 92%+ selama 15 menit (batas 80%), RAM 93% (batas 90%), disk 85% (batas 80%), koneksi 55 dari 60 (batas 80%).");
    expect(one("VulnerableDependency", "a1")).toBe("2 paket rentan (1 kritis, 1 tinggi): lodash 4.17.20 → 4.17.21, next 15.0.0 → 15.2.3.");
    expect(one("VulnerableDependency", "a2")).toMatch(/^6 paket rentan \(6 tinggi\): next 15\.0\.0 \(belum ada fix\), .*, \+2 lagi\.$/);
  });

  it("translates the back-to-normal messages too", () => {
    const ok = observations.filter((o) => o.status === "ok" && o.message);
    expect(ok.length).toBeGreaterThan(0);
    for (const o of ok) {
      const id = translateAlertText(o.rule, o.message);
      expect(id, o.message).not.toBe(o.message);
      for (const w of DENY) expect(id.toLowerCase(), `"${w}" left in: ${id}`).not.toContain(w);
    }
  });

  it("keeps a database alias, an email placeholder and odd characters as they are", () => {
    expect(translateAlertText("DatabasePaused", "Supabase project [email hidden]'s Project is paused.")).toBe("Project Supabase [email hidden]'s Project lagi di-pause.");
    expect(translateAlertText("MonitorDown", "a<b>.example.com/ returned HTTP 500 on 3 consecutive checks.")).toBe("a<b>.example.com/: 3 cek gagal berturut-turut (HTTP 500).");
  });

  it("returns text it doesn't recognise unchanged (a new rule, a reworded message, an old stored message)", () => {
    for (const [rule, text] of [["MonitorDown", "Something new happened."], ["NoSuchRule", "web returned HTTP 502 on 3 consecutive checks."], ["Test", "Hello."], ["HighLatency", ""], ["toString", "x"], ["__proto__", "x"]]) {
      expect(translateAlertText(rule, text)).toBe(text);
    }
  });
});
