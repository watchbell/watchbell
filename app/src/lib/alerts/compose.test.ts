import { afterEach, describe, expect, it } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import { composeMessage, nextStep, type Notice } from "./compose";

const now = new Date("2026-10-13T12:44:00Z");
const n = (o: Partial<Notice> = {}): Notice => ({
  kind: "open", ruleKey: "MonitorDown", severity: "critical", title: "orbit-blog /", message: "orbit-blog.vercel.app returned HTTP 502 on 3 consecutive checks.",
  startedAt: now, causedBy: null, provider: null, ...o,
});

describe("composeMessage", () => {
  it("strips markdown link syntax from Discord text, so an app name can't render as a masked link (M8)", () => {
    const m = composeMessage([n({ title: "[click](https://evil.example)", message: "see <https://evil.example> now" })], now, "https://ops.example.com");
    expect(m.discord).not.toMatch(/\[.*\]\(/);
    expect(m.discord).not.toContain("<https");
    expect(m.discord).toContain("click(https://evil.example)");
  });

  it("groups everything into one message with a count line", () => {
    const m = composeMessage([n(), n({ kind: "resolve", ruleKey: "HighLatency", severity: "warning", title: "api /", message: "p95 back under the limit." })], now, "https://ops.example.com");
    expect(m.telegram).toContain("<b>Watchbell</b>: 1 firing, 1 resolved");
    expect(m.telegram).toContain("FIRING · critical · MonitorDown · orbit-blog /");
    expect(m.telegram).toContain("RESOLVED · warning · HighLatency · api /");
    expect(m.telegram).toContain('<a href="https://ops.example.com/alerts">Open alerts</a>');
    expect(m.discord).toContain("**Watchbell**: 1 firing, 1 resolved");
  });

  it("escapes HTML and notes provider incidents", () => {
    const m = composeMessage([n({ title: "a<b>&c", provider: "Vercel" })], now, "https://ops.example.com");
    expect(m.telegram).toContain("a&lt;b&gt;&amp;c");
    expect(m.telegram).toContain("Vercel reports an incident");
  });

  it("stays inside Telegram's 4,096 and Discord's 2,000 characters", () => {
    const many = Array.from({ length: 80 }, (_, i) => n({ title: `app-${i} /`, message: "x".repeat(120) }));
    const m = composeMessage(many, now, "https://ops.example.com");
    expect(m.telegram.length).toBeLessThanOrEqual(4096);
    expect(m.discord.length).toBeLessThanOrEqual(2000);
    expect(m.telegram).toMatch(/\+\d+ more on the Alerts page/);
  });

  it("a firing rule nothing can fix on its own carries the next step (owner 17 Oct); a resolved one and an acted-on one don't", () => {
    const m = composeMessage([n({ ruleKey: "CredentialExpiring", severity: "warning", title: "Vercel token" }), n({ kind: "resolve", ruleKey: "DomainExpiringSoon", title: "example.com" })], now, "https://ops.example.com");
    expect(m.telegram).toContain("👉 Next step: create a new token");
    expect(m.discord).toContain("👉 Next step: create a new token");
    expect(m.telegram).not.toContain("renew the domain");
    expect(composeMessage([n()], now, "https://ops.example.com").telegram).not.toContain("Next step");
    expect(nextStep("CollectorStale")).toMatch(/^Next step: the watchdog/);
    expect(nextStep("MonitorDown")).toBeNull();
  });

  it("leaves the English untouched when no language or \"en\" is given", () => {
    const list = [n({ provider: "Vercel", causedBy: "CollectorStale" }), n({ kind: "repeat", ruleKey: "CredentialExpiring", severity: "warning" }), n({ kind: "resolve", severity: "info" })];
    expect(composeMessage(list, now, "https://ops.example.com", "en")).toEqual(composeMessage(list, now, "https://ops.example.com"));
  });
});

// Notification language (owner 19 Oct): everything Watchbell sends can be Indonesian; the web UI stays English.
describe("composeMessage in Indonesian", () => {
  const url = "https://ops.example.com";
  it("translates headers, severity, the count line, the hint, the extras and the footer", () => {
    const m = composeMessage([
      n({ message: "app-a.example.com/ returned HTTP 502 on 3 consecutive checks.", causedBy: "CollectorStale", provider: "Vercel" }),
      n({ kind: "repeat", ruleKey: "CredentialExpiring", severity: "warning", title: "vercel · acme", message: "The vercel credential acme expires in 3 days." }),
      n({ kind: "resolve", ruleKey: "HighLatency", severity: "info", title: "api /", message: "p95 1,800 ms over the last 10 minutes (limit 1,500 ms)." }),
    ], now, url, "id");
    expect(m.telegram).toContain("<b>Watchbell</b>: 2 aktif, 1 pulih · 19:44 WIB");
    expect(m.telegram).toContain("<b>MUNCUL · kritis · MonitorDown · orbit-blog /</b>\napp-a.example.com/: 3 cek gagal berturut-turut (HTTP 502).");
    expect(m.telegram).toContain("<i>gara-gara CollectorStale · Vercel lagi ada insiden</i>");
    expect(m.telegram).toContain("ULANG · peringatan · CredentialExpiring");
    expect(m.telegram).toContain("Credential vercel acme habis dalam 3 hari.");
    expect(m.telegram).toContain("👉 Langkah: bikin token baru dan ganti di Settings → Connections sebelum habis.");
    expect(m.telegram).toContain("PULIH · info · HighLatency");
    expect(m.telegram).toContain("sejak 19:44 WIB");
    expect(m.telegram).toContain('<a href="https://ops.example.com/alerts">Buka Alerts</a>');
    expect(m.discord).toContain("**Watchbell**: 2 aktif, 1 pulih");
    expect(m.discord).toContain("**MUNCUL · kritis · MonitorDown");
    expect(m.discord).toContain("_gara-gara CollectorStale · Vercel lagi ada insiden_");
    expect(m.discord).toContain("👉 Langkah: bikin token baru");
    for (const s of [m.telegram, m.discord]) expect(s).not.toMatch(/FIRING|REPEAT|RESOLVED|critical|warning|Next step|since |Open alerts|caused by|reports an incident|consecutive|expires/);
  });

  it("keeps escaping and scrubbing in Indonesian", () => {
    const m = composeMessage([n({ ruleKey: "DatabasePaused", title: "a<b>&c [x](https://evil.example)", message: "Supabase project <db> is paused." })], now, url, "id");
    expect(m.telegram).toContain("a&lt;b&gt;&amp;c");
    expect(m.telegram).toContain("Project Supabase &lt;db&gt; lagi di-pause.");
    expect(m.discord).not.toMatch(/\[.*\]\(/);
    expect(m.discord).not.toContain("<db>");
  });

  it("80 mixed notices stay inside 4,096 / 2,000 characters", () => {
    const kinds = ["open", "repeat", "resolve"] as const;
    const severities = ["critical", "warning", "info"] as const;
    const shapes: [string, (i: number) => string][] = [
      ["MonitorDown", (i) => `app-${i}.example.com/ returned HTTP 502 on 3 consecutive checks.`],
      ["CredentialExpiring", (i) => `The vercel credential token-${i} expires in 3 days.`],
      ["CollectorStale", (i) => `The last minute run finished ${i + 6} min ago.`],
      ["StorageAlmostFull", (i) => `db-${i} uses 450 MB of 500 MB (90%).`],
      ["ComputeHigh", (i) => `db-${i}: RAM 93% (limit 90%), disk 85% (limit 80%).`],
      ["DomainExpiringSoon", (i) => `app-${i}.example.com expires in ${i} days.`],
    ];
    const many = Array.from({ length: 80 }, (_, i) => n({
      kind: kinds[i % 3], severity: severities[i % 3], ruleKey: shapes[i % shapes.length][0], title: `app-${i} /`, causedBy: i % 4 ? null : "CollectorStale", provider: i % 5 ? null : "Vercel",
      message: shapes[i % shapes.length][1](i),
    }));
    const m = composeMessage(many, now, url, "id");
    expect(m.telegram.length).toBeLessThanOrEqual(4096);
    expect(m.discord.length).toBeLessThanOrEqual(2000);
    expect(m.telegram).toMatch(/\+\d+ lagi di halaman Alerts/);
    expect(m.discord).toMatch(/\+\d+ lagi di halaman Alerts/);
    for (const t of [m.telegram, m.discord]) expect(t).not.toMatch(/consecutive|expires|limit|uses|min ago|more on the Alerts page|FIRING|REPEAT|RESOLVED|since /);
  });

  it("restores the Indonesian next steps", () => {
    expect(nextStep("CollectorStale", "id")).toBe("Langkah: watchdog udah jalanin collector sendiri tiap 5 menit. Cek job di cron-job.org dan deploy terakhir di Vercel.");
    expect(nextStep("MonitorDown", "id")).toBeNull();
    expect(nextStep("CollectorStale")).toMatch(/^Next step: the watchdog/);
  });
});

describe("composeMessage in the configured zone (1.1)", () => {
  afterEach(() => resetTimeZoneForTests());

  it("says WIB by default, as before", () => {
    resetTimeZoneForTests();
    const m = composeMessage([n()], now, "https://ops.example.com");
    expect(m.telegram).toContain("<b>Watchbell</b>: 1 firing · 19:44 WIB");
    expect(m.telegram).toContain("since 19:44 WIB");
    expect(m.discord).toContain("**Watchbell**: 1 firing · 19:44 WIB");
  });

  it("Europe/Berlin: local clock with CEST in summer time and CET in winter time", () => {
    resetTimeZoneForTests("Europe/Berlin");
    const summer = composeMessage([n()], now, "https://ops.example.com");
    expect(summer.telegram).toContain("<b>Watchbell</b>: 1 firing · 14:44 CEST");
    expect(summer.telegram).toContain("since 14:44 CEST");
    expect(summer.discord).toContain("**Watchbell**: 1 firing · 14:44 CEST");
    const winter = new Date("2026-11-13T12:44:00Z");
    const m = composeMessage([n({ startedAt: new Date("2026-10-24T12:00:00Z") })], winter, "https://ops.example.com", "id");
    expect(m.telegram).toContain("· 13:44 CET");
    expect(m.telegram).toContain("sejak 14:00 CEST"); // it started before the clocks went back
    expect(m.telegram).not.toContain("WIB");
  });
});
