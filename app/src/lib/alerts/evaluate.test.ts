import { describe, expect, it } from "vitest";
import { RULE_KEYS, RULES, type RuleConfig } from "./catalog";
import { evaluate } from "./evaluate";
import type { Facts } from "./facts";

const now = new Date("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const rules: RuleConfig[] = RULE_KEYS.map((key) => ({ key, severity: RULES[key].severity, threshold: RULES[key].threshold, enabled: true, channels: ["telegram"] }));
const base: Facts = {
  now, lastMinuteRunAt: new Date(now.getTime() - 60_000), monitors: [], apps: [], accounts: [], dbs: null, domains: null, dns: null, links: [],
};
const mon = (o: Partial<Facts["monitors"][number]> = {}): Facts["monitors"][number] => ({
  id: "m1", appId: "a1", appName: "web", url: "https://web.example.com/", kind: "http", state: "ok", failStreak: 0, lastStatus: 200,
  lastCheckedAt: now, p95Last10: 300, checksLast10: 10, ...o,
});
const find = (r: ReturnType<typeof evaluate>, rule: string, subject: string) => r.observations.find((o) => o.rule === rule && o.subject === subject);

describe("evaluate: a monitor whose domain moved (1.2.1)", () => {
  it("fires MonitorDomainMoved instead of MonitorDown while the host is detached", () => {
    const r = evaluate({ ...base, monitors: [mon({ id: "mv", url: "https://old.example.com/health", failStreak: 5, state: "err", lastStatus: null, movedTo: "new.example.com" })] }, rules);
    expect(find(r, "MonitorDomainMoved", "mv")).toMatchObject({
      status: "firing", resourceId: "a1", title: "web /health", provider: "vercel",
      message: "old.example.com is no longer a domain of web; production is on new.example.com.",
    });
    expect(find(r, "MonitorDown", "mv")).toMatchObject({ status: "ok", message: "old.example.com moved to new.example.com; MonitorDomainMoved takes over." });
  });
  it("an attached host changes nothing: MonitorDomainMoved is ok and MonitorDown fires as before", () => {
    const r = evaluate({ ...base, monitors: [mon({ id: "d", failStreak: 3, state: "err", lastStatus: 502 }), mon({ id: "hb", kind: "heartbeat", url: "job", state: "ok" })] }, rules);
    expect(find(r, "MonitorDomainMoved", "d")).toMatchObject({ status: "ok", message: "The monitor checks web.example.com, a domain of web." });
    expect(find(r, "MonitorDown", "d")?.status).toBe("firing");
    expect(find(r, "MonitorDomainMoved", "hb")).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("says a missed keyword in the MonitorDown message, not HTTP 200", () => {
    const r = evaluate({ ...base, monitors: [mon({ id: "k", failStreak: 3, state: "err", lastStatus: 200, lastError: "Keyword not found" })] }, rules);
    expect(find(r, "MonitorDown", "k")).toMatchObject({ status: "firing", message: "web.example.com/ failed its check (Keyword not found) on 3 consecutive checks." });
    const plain = evaluate({ ...base, monitors: [mon({ id: "p", failStreak: 3, state: "err", lastStatus: 502, lastError: "HTTP 502" })] }, rules);
    expect(find(plain, "MonitorDown", "p")).toMatchObject({ message: "web.example.com/ returned HTTP 502 on 3 consecutive checks." });
  });

  it("says why a heartbeat is down: a fail ping, a start that didn't finish, or no ping (5b final review M1)", () => {
    const hb = (id: string, lastError: string | null) => mon({ id, kind: "heartbeat", url: "backup job", state: "err", failStreak: 3, lastStatus: null, lastError });
    const r = evaluate({ ...base, monitors: [
      hb("f", "Down · the job reported a failure"), hb("s", "Down · started but didn't finish"), hb("n", "Down · no ping for 2 h"), hb("x", null),
    ] }, rules);
    expect(find(r, "MonitorDown", "f")).toMatchObject({ status: "firing", title: "web backup job", message: "web · backup job: the job reported a failure." });
    expect(find(r, "MonitorDown", "s")?.message).toBe("web · backup job: started but didn't finish.");
    expect(find(r, "MonitorDown", "n")?.message).toBe("web · backup job: no ping for 2 h.");
    expect(find(r, "MonitorDown", "x")?.message).toBe("web · backup job: no ping in time.");
  });

  it("fires MonitorDown at the threshold, holds in between, clears at a pass", () => {
    const r = evaluate({ ...base, monitors: [mon({ id: "d", failStreak: 3, state: "err", lastStatus: 502 }), mon({ id: "h", failStreak: 1, state: "warn" }), mon({ id: "u" })] }, rules);
    expect(find(r, "MonitorDown", "d")).toMatchObject({ status: "firing", resourceId: "a1", title: "web /", message: "web.example.com/ returned HTTP 502 on 3 consecutive checks.", sampleAt: now });
    expect(find(r, "MonitorDown", "h")?.status).toBe("unknown");
    expect(find(r, "MonitorDown", "u")?.status).toBe("ok");
  });

  it("fires HighLatency only with enough samples", () => {
    const r = evaluate({ ...base, monitors: [mon({ id: "s", p95Last10: 1800 }), mon({ id: "f", p95Last10: 1800, checksLast10: 3 })] }, rules);
    expect(find(r, "HighLatency", "s")).toMatchObject({ status: "firing", message: "p95 1,800 ms over the last 10 minutes (limit 1,500 ms)." });
    expect(find(r, "HighLatency", "f")?.status).toBe("unknown");
  });

  it("judges the collector by its last minute run", () => {
    expect(find(evaluate({ ...base, lastMinuteRunAt: new Date(now.getTime() - 6 * 60_000) }, rules), "CollectorStale", "collector")?.status).toBe("firing");
    expect(find(evaluate({ ...base, lastMinuteRunAt: null }, rules), "CollectorStale", "collector")?.message).toBe("The collector hasn't finished a run yet.");
    expect(find(evaluate(base, rules), "CollectorStale", "collector")?.status).toBe("ok");
  });

  it("fires DeploymentFailed on a failed latest production deployment and holds while building", () => {
    const apps = [
      { id: "a1", name: "web", latestProduction: { state: "error", sha: "0d3c8aa1", createdAt: now } },
      { id: "a2", name: "api", latestProduction: { state: "building", sha: null, createdAt: now } },
      { id: "a3", name: "old", latestProduction: null },
    ];
    const r = evaluate({ ...base, apps }, rules);
    expect(find(r, "DeploymentFailed", "a1")).toMatchObject({ status: "firing", message: "Production deployment 0d3c8aa failed." });
    expect(find(r, "DeploymentFailed", "a2")?.status).toBe("unknown");
    expect(find(r, "DeploymentFailed", "a3")?.status).toBe("ok");
  });

  it("warns about credentials that expire soon, not about those without a date", () => {
    const accounts = [
      { id: "c1", provider: "vercel", label: "acme", expiresAt: new Date(now.getTime() + 10 * DAY), status: "ok" as const, lastError: null },
      { id: "c2", provider: "neon", label: "utama", expiresAt: null, status: "ok" as const, lastError: null },
      { id: "c3", provider: "drive", label: "acme", expiresAt: null, status: "error" as const, lastError: "invalid_grant" },
    ];
    const r = evaluate({ ...base, accounts }, rules);
    expect(find(r, "CredentialExpiring", "c1")).toMatchObject({ status: "firing", accountId: "c1", message: "The vercel credential acme expires in 10 days." });
    expect(find(r, "CredentialExpiring", "c2")?.status).toBe("ok");
    expect(find(r, "CredentialExpiring", "c3")).toMatchObject({ status: "firing", message: "Google Drive access was removed (invalid_grant). Reconnect it." });
  });

  it("doesn't evaluate rules whose stage hasn't delivered data", () => {
    const r = evaluate(base, rules);
    expect(r.evaluated.has("DatabasePaused")).toBe(false);
    expect(r.evaluated.has("CertExpiringSoon")).toBe(false);
    expect(r.evaluated.has("MonitorDown")).toBe(true);
  });

  it("evaluates database, domain and DNS rules when stages 3 and 4 deliver", () => {
    const dbs = [
      { id: "s1", name: "quillpad", provider: "supabase" as const, state: "paused" as const, sizeBytes: 450e6, sizeLimitBytes: 500e6, lastApiAt: new Date(now.getTime() - 5 * DAY), cuHours: null, cuLimit: null, readsToday: null, readsLimit: null, quotaExhausted: null },
      { id: "n1", name: "ticketer", provider: "neon" as const, state: "idle" as const, sizeBytes: 100e6, sizeLimitBytes: 1e9, lastApiAt: null, cuHours: 85, cuLimit: 100, readsToday: null, readsLimit: null, quotaExhausted: null },
      { id: "f1", name: "orbit-blog", provider: "firestore" as const, state: "ok" as const, sizeBytes: null, sizeLimitBytes: null, lastApiAt: null, cuHours: null, cuLimit: null, readsToday: 41_000, readsLimit: 50_000, quotaExhausted: false },
    ];
    const domains = [{ id: "d1", name: "tiket.example.com", tlsNotAfter: new Date(now.getTime() + 12 * DAY), expiresAt: null }];
    const dns = [{ id: "z1:r1", resourceId: "d1", name: "tiket.example.com", proxied: true, pointsToVercel: true }];
    const r = evaluate({ ...base, dbs, domains, dns }, rules);
    expect(find(r, "DatabasePaused", "s1")?.status).toBe("firing");
    expect(find(r, "StorageAlmostFull", "s1")).toMatchObject({ status: "firing", message: "quillpad uses 450 MB of 500 MB (90%)." });
    expect(find(r, "AutoPauseRisk", "s1")?.status).toBe("ok"); // already paused: DatabasePaused covers it
    expect(find(r, "NeonComputeHigh", "n1")).toMatchObject({ status: "firing", message: "ticketer used 85 of 100 CU-hours this month." });
    expect(find(r, "FirestoreQuotaHigh", "f1")).toMatchObject({ status: "firing", message: "orbit-blog read 41,000 of 50,000 documents today (82%)." });
    expect(find(r, "CertExpiringSoon", "d1")).toMatchObject({ status: "firing", message: "The TLS certificate of tiket.example.com expires in 12 days." });
    expect(find(r, "DomainExpiringSoon", "d1")?.status).toBe("unknown");
    expect(find(r, "DnsProxiedToVercel", "z1:r1")).toMatchObject({ status: "firing", resourceId: "d1" });
  });

  it("can evaluate one rule only (the watchdog)", () => {
    const r = evaluate({ ...base, monitors: [mon({ failStreak: 3 })] }, rules, ["CollectorStale"]);
    expect([...r.evaluated]).toEqual(["CollectorStale"]);
    expect(r.observations.every((o) => o.rule === "CollectorStale")).toBe(true);
  });

  it("skips disabled rules", () => {
    const off = rules.map((x) => (x.key === "MonitorDown" ? { ...x, enabled: false } : x));
    expect(evaluate({ ...base, monitors: [mon({ failStreak: 3 })] }, off).evaluated.has("MonitorDown")).toBe(false);
  });
});

// Owner 12 Nov: OsSecurityUpdate over the last scan of the machine a self-hosted Watchbell runs on.
describe("evaluate: OsSecurityUpdate (owner 12 Nov)", () => {
  const os = (o: Partial<NonNullable<Facts["os"]>> = {}): NonNullable<Facts["os"]> => ({ ...{ system: "Ubuntu 22.04.5 LTS", updates: [{ source: "gst-plugins-base1.0", score: 9.8, cves: ["CVE-2026-111183"] }, { source: "gst-plugins-good1.0", score: 9.8, cves: ["CVE-2026-111183", "CVE-2026-46471"] }], kernelWaiting: { installed: "5.15.0-203.213", running: "5.15.0-202.212" } }, ...o });
  const ev = (f: Facts["os"]) => evaluate({ ...base, os: f }, rules, ["OsSecurityUpdate"]);
  it("fires, critical, while a waiting update fixes a CVE scored 9+, naming it and the pending kernel", () => {
    expect(find(ev(os()), "OsSecurityUpdate", "os")).toMatchObject({
      status: "firing", severity: "critical", title: "Ubuntu 22.04.5 LTS",
      message: "On Ubuntu 22.04.5 LTS: gst-plugins-base1.0 fixes CVE-2026-111183 (9.8); gst-plugins-good1.0 fixes CVE-2026-111183 (9.8) and 1 more; kernel 5.15.0-203.213 waits for a reboot.",
    });
  });
  it("a fix scored under the threshold (7) doesn't fire on its own; a kernel waiting for a reboot does, as a warning", () => {
    const low = [{ source: "glib2.0", score: 5.5, cves: ["CVE-2026-1"] }];
    const k = find(ev(os({ updates: low })), "OsSecurityUpdate", "os");
    expect(k).toMatchObject({ status: "firing", message: "On Ubuntu 22.04.5 LTS: kernel 5.15.0-203.213 waits for a reboot." });
    expect(k?.severity).toBeUndefined();
    expect(find(ev(os({ updates: low, kernelWaiting: null })), "OsSecurityUpdate", "os")).toMatchObject({
      status: "ok", message: "On Ubuntu 22.04.5 LTS, no waiting security update fixes a CVE scored 7.0 or more, and the newest kernel runs.",
    });
  });
  it("names three packages and counts the rest", () => {
    const many = ["a", "b", "c", "d", "e"].map((s) => ({ source: s, score: 7.5, cves: [`CVE-2026-${s.charCodeAt(0)}`] }));
    expect(find(ev(os({ updates: many, kernelWaiting: null })), "OsSecurityUpdate", "os")?.message).toBe("On Ubuntu 22.04.5 LTS: a fixes CVE-2026-97 (7.5); b fixes CVE-2026-98 (7.5); c fixes CVE-2026-99 (7.5); 2 more packages.");
  });
  it("a scan with a lookup that failed fires on what it knows but never resolves (review I2)", () => {
    expect(find(ev(os({ partial: true, kernelWaiting: null })), "OsSecurityUpdate", "os")?.status).toBe("firing");
    expect(find(ev(os({ partial: true, updates: [], kernelWaiting: null })), "OsSecurityUpdate", "os")?.status).toBe("unknown");
  });
  it("isn't evaluated without a scan (the cloud edition, or not scanned yet)", () => {
    expect(evaluate({ ...base }, rules, ["OsSecurityUpdate"]).evaluated.has("OsSecurityUpdate")).toBe(false);
    expect(evaluate({ ...base, os: null }, rules, ["OsSecurityUpdate"]).evaluated.has("OsSecurityUpdate")).toBe(false);
  });
});

// Watchbell 1.4: CiFailing over the default branch's latest Actions run (github_repos.actions, read in the daily sync).
describe("evaluate: CiFailing (1.4)", () => {
  const apps = [{ id: "a1", name: "web", latestProduction: null }];
  const run = (o: Partial<Exclude<NonNullable<NonNullable<Facts["ci"]>[number]["run"]>, { none: true }>> = {}) => ({
    status: "completed", conclusion: "success", name: "CI", branch: "main", sha: "a".repeat(40), url: "https://github.com/me/web/actions/runs/1", at: now.toISOString(), runNumber: 42, ...o,
  });
  const ci = (r: NonNullable<Facts["ci"]>[number]["run"]) => evaluate({ ...base, apps, ci: [{ appId: "a1", repo: "me/web", branch: "main", run: r }] }, rules, ["CiFailing"]);
  it("fires when the latest run on the default branch failed", () => {
    expect(find(ci(run({ conclusion: "failure" })), "CiFailing", "a1")).toMatchObject({ status: "firing", title: "web", message: "The latest CI run on main failed (run #42)." });
    expect(find(ci(run({ conclusion: "timed_out" })), "CiFailing", "a1")?.status).toBe("firing");
  });
  it("resolves on a passing run", () => {
    expect(find(ci(run()), "CiFailing", "a1")).toMatchObject({ status: "ok", message: "The latest CI run on main passed." });
  });
  it("says nothing new while a run is going, was cancelled, or there is none", () => {
    for (const r of [run({ status: "in_progress", conclusion: null }), run({ conclusion: "cancelled" }), { none: true as const }, null]) {
      const o = find(ci(r), "CiFailing", "a1");
      expect(o?.status).toBe("unknown");
    }
  });
  it("isn't evaluated without any Actions data (the token may lack Actions: Read)", () => {
    expect(evaluate({ ...base, apps, ci: [] }, rules, ["CiFailing"]).evaluated.has("CiFailing")).toBe(false);
    expect(evaluate({ ...base, apps, ci: null }, rules, ["CiFailing"]).evaluated.has("CiFailing")).toBe(false);
  });
});
