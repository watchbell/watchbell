import { describe, expect, it, vi } from "vitest";
import { buildDigest, type DigestState, digestDue, stepDigest } from "./digest";

describe("digestDue", () => {
  it("sends once a WIB day, after 07:00 WIB", () => {
    expect(digestDue(new Date("2026-10-12T23:59:00Z"), null)).toBe(false);      // 06:59 WIB on the 13th
    expect(digestDue(new Date("2026-10-13T00:00:00Z"), null)).toBe(true);       // 07:00 WIB
    expect(digestDue(new Date("2026-10-13T05:00:00Z"), "2026-10-13")).toBe(false);
    expect(digestDue(new Date("2026-10-13T05:00:00Z"), "2026-10-12")).toBe(true);
  });
});

describe("buildDigest never contains an email (privacy)", () => {
  it("hides any address left in the subject, text and HTML", () => {
    const d = buildDigest({
      now: new Date("2026-10-13T00:00:00Z"), siteUrl: "https://ops.example.com",
      firing: [{ ruleKey: "CredentialExpiring", severity: "info", title: "supabase · me@gmail.com", message: "The supabase credential me@gmail.com expires in 3 days.", startedAt: new Date("2026-10-12T02:12:00Z") }],
      opened: 1, resolved: [], apps: [], providers: [],
    });
    for (const s of [d.subject, d.text, d.html]) expect(s).not.toContain("me@gmail.com");
    expect(d.text).toContain("supabase · [email hidden]");
  });
});

describe("buildDigest", () => {
  it("summarises the last 24 hours in a subject, HTML and text", () => {
    const d = buildDigest({
      now: new Date("2026-10-13T00:00:00Z"), siteUrl: "https://ops.example.com",
      firing: [{ ruleKey: "DatabasePaused", severity: "warning", title: "quillpad", message: "Supabase project quillpad is paused.", startedAt: new Date("2026-10-12T02:12:00Z") }],
      opened: 3, resolved: [{ ruleKey: "MonitorDown", title: "nova-wallet /", took: "6 min" }],
      apps: [{ name: "orbit-blog", uptime: 98.7, errors: 14 }, { name: "acme-shop", uptime: 100, errors: 0 }],
      providers: [{ label: "Cloudflare", text: "Scheduled maintenance · SIN" }],
    });
    expect(d.subject).toBe("Watchbell · 13 Oct · 1 firing, 3 opened, 1 resolved");
    expect(d.text).toContain("Still firing\n- warning · DatabasePaused · quillpad: Supabase project quillpad is paused.");
    expect(d.text).toContain("orbit-blog: 98.70% up, 14 stored errors");
    expect(d.text).toContain("MonitorDown · nova-wallet / (after 6 min)");
    expect(d.text).toContain("Cloudflare: Scheduled maintenance · SIN");
    expect(d.html).toContain("<h2");
    expect(d.html).not.toContain("<script");
    expect(d.text).toContain("https://ops.example.com/alerts");
  });
  it("lists the worst application first and says so when nothing happened", () => {
    const d = buildDigest({
      now: new Date("2026-10-13T00:00:00Z"), siteUrl: "https://ops.example.com/", firing: [], opened: 0, resolved: [],
      apps: [{ name: "acme-shop", uptime: 100, errors: 0 }, { name: "orbit-blog", uptime: 98.7, errors: 14 }, { name: "quiet", uptime: null, errors: 0 }], providers: [],
    });
    expect(d.text.indexOf("orbit-blog")).toBeLessThan(d.text.indexOf("acme-shop"));
    expect(d.text).toContain("quiet: no checks, 0 stored errors");
    expect(d.text).toContain("Nothing is firing.");
    expect(d.text).toContain("https://ops.example.com/alerts");
    expect(d.text).not.toContain("//alerts");
  });
  it("escapes HTML in titles", () => {
    const d = buildDigest({ now: new Date(), siteUrl: "https://x", firing: [{ ruleKey: "R", severity: "info", title: "<b>", message: "&", startedAt: new Date() }], opened: 0, resolved: [], apps: [], providers: [] });
    expect(d.html).toContain("&lt;b&gt;");
  });
});

// Notification language (owner 19 Oct): the digest follows it; the stored English alert text is translated on the way out.
describe("buildDigest in Indonesian", () => {
  const input = {
    now: new Date("2026-10-13T00:00:00Z"), siteUrl: "https://ops.example.com",
    firing: [
      { ruleKey: "DatabasePaused", severity: "warning" as const, title: "db-a", message: "Supabase project db-a is paused.", startedAt: new Date("2026-10-12T02:12:00Z") },
      { ruleKey: "Unknown", severity: "critical" as const, title: "x", message: "Something new.", startedAt: new Date("2026-10-12T02:12:00Z") },
    ],
    opened: 3, resolved: [{ ruleKey: "MonitorDown", title: "nova-wallet /", took: "6 min" }],
    apps: [{ name: "orbit-blog", uptime: 98.7, errors: 14 }, { name: "quiet", uptime: null, errors: 1 }],
    providers: [{ label: "Cloudflare", text: "Scheduled maintenance · SIN" }],
  };

  it("writes durations in Indonesian words", () => {
    const took = (s: string) => buildDigest({ ...input, resolved: [{ ruleKey: "MonitorDown", title: "t", took: s }] }, "id").text;
    expect(took("2 h 5 min")).toContain("(setelah 2 jam 5 menit)");
    expect(took("2 d 4 h")).toContain("(setelah 2 hari 4 jam)");
    expect(buildDigest({ ...input, resolved: [{ ruleKey: "MonitorDown", title: "t", took: "6 min" }] }, "en").text).toContain("(after 6 min)");
  });

  it("writes the subject, sections and lines in Indonesian", () => {
    const d = buildDigest(input, "id");
    expect(d.subject).toBe("Watchbell · 13 Okt · 2 aktif, 3 baru, 1 pulih");
    expect(d.text).toContain("2 aktif, 3 baru, 1 pulih dalam 24 jam terakhir.");
    expect(d.text).toContain("Masih aktif\n- peringatan · DatabasePaused · db-a: Project Supabase db-a lagi di-pause.");
    expect(d.text).toContain("- kritis · Unknown · x: Something new.");
    expect(d.text).toContain("Pulih\n- MonitorDown · nova-wallet / (setelah 6 menit)");
    expect(d.text).toContain("Aplikasi (24 jam)\n- orbit-blog: 98.70% aktif, 14 error tersimpan");
    expect(d.text).toContain("quiet: belum ada cek, 1 error tersimpan");
    expect(d.text).toContain("Provider\n- Cloudflare: Scheduled maintenance · SIN");
    expect(d.text).toContain("Buka Alerts: https://ops.example.com/alerts");
    expect(d.html).toContain(">Masih aktif</h3>");
    expect(d.html).toContain(">Buka Alerts</a>");
    for (const s of [d.subject, d.text, d.html]) expect(s).not.toMatch(/firing|opened|resolved|Still|Nothing|stored error|Open alerts|is paused/);
  });

  it("says so in Indonesian when nothing happened", () => {
    const d = buildDigest({ ...input, firing: [], resolved: [], apps: [], providers: [] }, "id");
    expect(d.text).toContain("Nggak ada yang aktif.");
    expect(d.text).toContain("Nggak ada yang pulih.");
  });

  it("is today's English without a language", () => {
    expect(buildDigest(input, "en")).toEqual(buildDigest(input));
    expect(buildDigest(input).subject).toBe("Watchbell · 13 Oct · 2 firing, 3 opened, 1 resolved");
  });
});

// I4: the digest is built once a day and stored; every retry sends the stored content, with a bounded backoff.
describe("stepDigest", () => {
  const built = { subject: "Watchbell · 13 Oct · 0 firing, 0 opened, 0 resolved", html: "<p>x</p>", text: "x" };
  const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00Z`); // 00:00Z is 07:00 WIB
  const io = (o: Partial<Parameters<typeof stepDigest>[1]> = {}) => ({
    lastSentDay: null as string | null, state: null as DigestState | null, build: vi.fn().mockResolvedValue(built), send: vi.fn().mockResolvedValue({ ok: true }), ...o,
  });
  const failed = (o: Partial<DigestState> = {}): DigestState => ({ day: "2026-10-13", ...built, attempts: 1, lastAttemptAt: at("00:00").toISOString(), stopped: false, lastError: "x", ...o });

  it("does nothing before 07:00 WIB or after today's digest was sent", async () => {
    const a = io();
    expect((await stepDigest(at("23:00"), a)).acted).toBe(false);
    expect((await stepDigest(at("05:00"), io({ lastSentDay: "2026-10-13" }))).acted).toBe(false);
    expect(a.build).not.toHaveBeenCalled();
  });

  it("builds once, sends, and marks the day as sent", async () => {
    const a = io();
    const r = await stepDigest(at("00:00"), a);
    expect(a.build).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith(built);
    expect(r).toMatchObject({ acted: true, sentDay: "2026-10-13", state: null, event: null });
  });

  it("stores the content on a transient failure and resends the same stored content, without building again", async () => {
    const a = io({ send: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "Resend didn't answer." }) });
    const first = await stepDigest(at("00:00"), a);
    expect(first.state).toMatchObject({ day: "2026-10-13", ...built, attempts: 1, stopped: false, lastError: "Resend didn't answer." });
    expect(first.sentDay).toBeNull();
    const b = io({ state: first.state, send: vi.fn().mockResolvedValue({ ok: true }) });
    const second = await stepDigest(at("00:06"), b);
    expect(b.build).not.toHaveBeenCalled();
    expect(b.send).toHaveBeenCalledWith(built);
    expect(second.sentDay).toBe("2026-10-13");
  });

  it("waits longer after each failure: 5, 15, 30, then 60 minutes", async () => {
    const gaps = [[1, 5], [2, 15], [3, 30], [4, 60]];
    for (const [attempts, minutes] of gaps) {
      const state = failed({ attempts });
      const early = io({ state });
      expect((await stepDigest(new Date(at("00:00").getTime() + (minutes - 1) * 60_000), early)).acted).toBe(false);
      expect(early.send).not.toHaveBeenCalled();
      const due = io({ state, send: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "e" }) });
      expect((await stepDigest(new Date(at("00:00").getTime() + minutes * 60_000), due)).acted).toBe(true);
      expect(due.send).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after 5 attempts a day and records one event", async () => {
    const a = io({ state: failed({ attempts: 4 }), send: vi.fn().mockResolvedValue({ ok: false, kind: "transient", error: "Resend returned an error (502)." }) });
    const r = await stepDigest(at("01:10"), a);
    expect(r.state).toMatchObject({ attempts: 5, stopped: true });
    expect(r.event).toEqual({ message: "Daily digest not sent", detail: "Resend returned an error (502). Gave up after 5 attempts today." });
    const later = io({ state: r.state });
    expect((await stepDigest(at("04:00"), later)).acted).toBe(false);
    expect(later.send).not.toHaveBeenCalled();
  });

  it("stops at once after a config error (a 4xx, for example an unverified From address) and records one event", async () => {
    const a = io({ send: vi.fn().mockResolvedValue({ ok: false, kind: "config", error: "Resend: Invalid from" }) });
    const r = await stepDigest(at("00:00"), a);
    expect(r.state).toMatchObject({ attempts: 1, stopped: true, lastError: "Resend: Invalid from" });
    expect(r.event).toEqual({ message: "Daily digest not sent", detail: "Resend: Invalid from. Fix it and the next digest goes out tomorrow." });
    expect((await stepDigest(at("06:00"), io({ state: r.state }))).acted).toBe(false);
  });

  it("starts fresh the next WIB day: yesterday's stopped state and stored content are ignored", async () => {
    const old = failed({ day: "2026-10-12", attempts: 5, stopped: true });
    const a = io({ state: old, lastSentDay: "2026-10-11" });
    const r = await stepDigest(at("00:00"), a);
    expect(a.build).toHaveBeenCalledTimes(1);
    expect(r.sentDay).toBe("2026-10-13");
  });
});
