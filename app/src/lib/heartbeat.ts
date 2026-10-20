// U3 (Healthchecks.io's model): the owner's job pings a secret URL. Up within the period, late within the grace, down
// after; /fail is down at once; /start then nothing within the grace is down. Tokens are 128 random bits, shown once,
// stored as sha256 only (B2).
// Client-safe: the Uptime dialog imports this module, so it must stay free of Node built-ins. The token generator,
// the hash and the url key live in heartbeat-token.ts (server-only).
import { DOWN_AFTER } from "@/lib/collector/rules";

export const PERIODS_S = [300, 3600, 86_400, 604_800] as const;
export const GRACES_S = [300, 3600, 21_600] as const;
export const MAX_HEARTBEATS = 20;
const TOKEN = /^hb_[0-9a-f]{32}$/;

// A token kept in a setting (DAILY_HEARTBEAT_TOKEN, 15 Oct): the value may carry a newline, spaces, quotes or the
// whole ping URL. Exactly one hb_ token in it (not part of a longer hex run) → that token; anything else → null.
export function tokenFromSetting(raw: string | undefined | null): string | null {
  const found = String(raw ?? "").match(/(?<![0-9a-z_])hb_[0-9a-f]{32}(?![0-9a-zA-Z])/g) ?? [];
  return found.length === 1 ? found[0] : null;
}

export function parsePing(parts: string[]): { token: string; kind: "ok" | "fail" | "start" } | null {
  const [token, action, ...rest] = parts;
  if (!token || !TOKEN.test(token) || rest.length) return null;
  if (action === undefined) return { token, kind: "ok" };
  return action === "fail" || action === "start" ? { token, kind: action } : null;
}

const span = (ms: number) => {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
};

export function heartbeatState(
  m: { lastPingAt: Date | null; lastPingKind: "ok" | "fail" | "start" | null; periodS: number; graceS: number; createdAt: Date }, now: Date,
): { state: "ok" | "warn" | "err" | "unknown"; text: string; failStreak: number } {
  const down = (text: string) => ({ state: "err" as const, text: `Down · ${text}`, failStreak: DOWN_AFTER });
  const period = m.periodS * 1000;
  const grace = m.graceS * 1000;
  if (!m.lastPingAt) {
    return now.getTime() - m.createdAt.getTime() <= period + grace ? { state: "unknown", text: "Waiting for the first ping", failStreak: 0 } : down("never pinged");
  }
  const since = now.getTime() - m.lastPingAt.getTime();
  if (m.lastPingKind === "fail") return down("the job reported a failure");
  if (m.lastPingKind === "start" && since > grace) return down("started but didn't finish");
  if (since <= period) return { state: "ok", text: `Up · pinged ${span(since)} ago`, failStreak: 0 };
  if (since <= period + grace) return { state: "warn", text: `Late · last ping ${span(since)} ago`, failStreak: 1 };
  return down(`no ping for ${span(since)}`);
}

// The dialog's and the Uptime table's words for a period or grace: "5 min", "1 h", "6 h", "1 day", "1 week".
export function durationLabel(s: number): string {
  if (s % 604_800 === 0) return s === 604_800 ? "1 week" : `${s / 604_800} weeks`;
  if (s % 86_400 === 0) return s === 86_400 ? "1 day" : `${s / 86_400} days`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}

// The URL the owner's job calls. Only ever built for the one response that shows it.
export function pingUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/ping/${token}`;
}
