import { describe, expect, it } from "vitest";
import { durationLabel, heartbeatState, parsePing, pingUrl, tokenFromSetting } from "./heartbeat";
import { heartbeatKey, newToken, tokenHash } from "./heartbeat-token";

const now = new Date("2026-10-13T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const hb = (o: Partial<Parameters<typeof heartbeatState>[0]> = {}) => ({ lastPingAt: ago(600), lastPingKind: "ok" as const, periodS: 3600, graceS: 600, createdAt: ago(86_400), ...o });

describe("tokens", () => {
  it("makes 128-bit tokens and stores only their hash", () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^hb_[0-9a-f]{32}$/);
    expect(hash).toBe(tokenHash(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken().token).not.toBe(token);
  });
  it("parses /api/ping/{token}[/fail|/start] and nothing else", () => {
    const t = "hb_0123456789abcdef0123456789abcdef";
    expect(parsePing([t])).toEqual({ token: t, kind: "ok" });
    expect(parsePing([t, "fail"])).toEqual({ token: t, kind: "fail" });
    expect(parsePing([t, "start"])).toEqual({ token: t, kind: "start" });
    for (const bad of [[], ["hb_short"], [t, "other"], [t, "fail", "x"], ["HB_0123456789ABCDEF0123456789ABCDEF"]]) expect(parsePing(bad)).toBeNull();
  });
});

describe("heartbeatState", () => {
  it("is up within the period, late within the grace, down after", () => {
    expect(heartbeatState(hb(), now)).toEqual({ state: "ok", text: "Up · pinged 10 min ago", failStreak: 0 });
    expect(heartbeatState(hb({ lastPingAt: ago(3900) }), now)).toEqual({ state: "warn", text: "Late · last ping 1 h ago", failStreak: 1 });
    expect(heartbeatState(hb({ lastPingAt: ago(4300) }), now)).toEqual({ state: "err", text: "Down · no ping for 1 h", failStreak: 3 });
  });
  it("goes down at once on a /fail ping", () => {
    expect(heartbeatState(hb({ lastPingKind: "fail" }), now)).toEqual({ state: "err", text: "Down · the job reported a failure", failStreak: 3 });
  });
  it("is down when a started job doesn't finish within the grace", () => {
    expect(heartbeatState(hb({ lastPingKind: "start", lastPingAt: ago(300) }), now).state).toBe("ok");
    expect(heartbeatState(hb({ lastPingKind: "start", lastPingAt: ago(700) }), now)).toMatchObject({ state: "err", text: "Down · started but didn't finish" });
  });
  it("waits for the first ping, then calls it down", () => {
    expect(heartbeatState(hb({ lastPingAt: null, lastPingKind: null, createdAt: ago(60) }), now)).toEqual({ state: "unknown", text: "Waiting for the first ping", failStreak: 0 });
    expect(heartbeatState(hb({ lastPingAt: null, lastPingKind: null, createdAt: ago(5000) }), now)).toMatchObject({ state: "err", text: "Down · never pinged" });
  });
});

describe("labels and keys", () => {
  it("names the periods and graces as the dialog does", () => {
    expect([300, 3600, 21_600, 86_400, 604_800].map(durationLabel)).toEqual(["5 min", "1 h", "6 h", "1 day", "1 week"]);
  });
  it("keys a heartbeat by a slug of its name, so one app can't have two of the same name", () => {
    expect(heartbeatKey("Backup job")).toBe("heartbeat:backup-job");
    expect(heartbeatKey("  backup   JOB! ")).toBe("heartbeat:backup-job");
    expect(heartbeatKey("db/nightly_dump")).toBe("heartbeat:db-nightly-dump");
    expect(heartbeatKey("バックアップ")).toMatch(/^heartbeat:[0-9a-f]{16}$/);
    expect(heartbeatKey("バックアップ")).not.toBe(heartbeatKey("ジョブ"));
  });
  it("builds the ping URL on the site's address", () => {
    expect(pingUrl("https://ops.example.com/", "hb_x")).toBe("https://ops.example.com/api/ping/hb_x");
    expect(pingUrl("http://localhost:3100", "hb_x")).toBe("http://localhost:3100/api/ping/hb_x");
  });
});

// 15 Oct: the console's own daily heartbeat never pinged although the daily run was fine; the token comes from an env
// value (DAILY_HEARTBEAT_TOKEN) that may carry a newline, spaces, quotes or the whole ping URL.
describe("tokenFromSetting", () => {
  const tok = "hb_0123456789abcdef0123456789abcdef";
  it("takes the token as is, or out of whitespace, quotes or a ping URL", () => {
    expect(tokenFromSetting(tok)).toBe(tok);
    expect(tokenFromSetting(`${tok}
`)).toBe(tok);
    expect(tokenFromSetting(`  ${tok}
`)).toBe(tok);
    expect(tokenFromSetting(`"${tok}"`)).toBe(tok);
    expect(tokenFromSetting(`https://ops.example.dev/api/ping/${tok}`)).toBe(tok);
    expect(tokenFromSetting(`https://ops.example.dev/api/ping/${tok}/fail`)).toBe(tok);
  });
  it("gives null when there is no single valid token", () => {
    expect(tokenFromSetting(undefined)).toBeNull();
    expect(tokenFromSetting("")).toBeNull();
    expect(tokenFromSetting("hb_123")).toBeNull();
    expect(tokenFromSetting("HB_0123456789ABCDEF0123456789ABCDEF")).toBeNull();
    expect(tokenFromSetting(`${tok}0`)).toBeNull(); // 33 hex: not a token
    expect(tokenFromSetting(`${tok} ${tok.replace("0", "1")}`)).toBeNull(); // two tokens: ambiguous
  });
});
